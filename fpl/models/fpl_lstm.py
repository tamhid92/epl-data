#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations
from pathlib import Path
from typing import List, Dict, Tuple
import warnings
warnings.filterwarnings("ignore", category=UserWarning)
import time
import numpy as np
import pandas as pd
import sys
import torch
import torch.nn as nn
import torch.optim as optim
from sklearn.preprocessing import StandardScaler

from configparser import ConfigParser
config = ConfigParser()
config.read("config.ini")

OUTPUT_DIR     = config.get("DATA_DIRS","OUT_DIR")
HISTORICAL_CSV = config.get("DATA_DIRS","HISTORICAL_CSV")
CURRENT_CSV    = config.get("DATA_DIRS","CURRENT_CSV")
FIXTURES_CSV   = config.get("DATA_DIRS","FIXTURES_CSV")
TEAMS_CSV      = config.get("DATA_DIRS","TEAMS_CSV")

MODEL = "lstm"

META_KO = "__meta_kickoff_time"
META_GW = "__meta_GW"
VERBOSE_EVERY = 1
SEED = 1337
EPOCHS = 100
BATCH_SIZE = 128
LR = 2e-3
WEIGHT_DECAY = 1e-4
PATIENCE = 30          
MIN_SEQ_LEN = 2         
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

LEAKAGE_COLS = {
    "total_points", "team_a_score", "team_h_score",
    "goals_scored", "assists", "saves",
    "yellow_cards", "red_cards", "own_goals",
    "bonus", "bps", "xP",
    "clean_sheets", "minutes",
    "selected", "modified",
    "starts", "clearances_blocks_interceptions", "defensive_contribution",
    "recoveries", "tackles",
}

PREFERRED_FEATURES = [
    "ict_index", "creativity", "influence", "threat",
    "expected_goals", "expected_assists", "expected_goal_involvements",
    "expected_goals_conceded",
    "was_home", "GW", "round",
    "team_strength", "opp_strength",
    "team_strength_def", "team_strength_att", "team_strength_oa",
    "opp_strength_def", "opp_strength_att", "opp_strength_oa",
    "value", "transfers_in", "transfers_out", "transfers_balance",
    "form",
]

POS_MAP = {"GK": 1, "DEF": 2, "MID": 3, "FWD": 4}

def set_seed(seed=SEED):
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)

def read_csv_safe(path) -> pd.DataFrame:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Missing required file: {p}")
    return pd.read_csv(p, low_memory=False)

def _to_num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s, errors="coerce")

def normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [c.strip() for c in df.columns]
    if "GW" in df.columns:
        df["GW"] = _to_num(df["GW"]).astype("Int64")
    if "round" in df.columns:
        df["round"] = _to_num(df["round"]).astype("Int64")
    if "was_home" in df.columns:
        if df["was_home"].dtype != bool:
            df["was_home"] = (
                df["was_home"].astype(str).str.lower().map(
                    {"true": True, "false": False, "1": True, "0": False}
                ).fillna(False)
            )
    if "kickoff_time" in df.columns:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            df["kickoff_time"] = pd.to_datetime(df["kickoff_time"], errors="coerce", utc=True)
    return df

def top_k(contrib: Dict[str, float], k: int = 4) -> List[str]:

    if not contrib:
        return []
    ranked = sorted(contrib.items(), key=lambda kv: -abs(kv[1]))[:k]
    out = []
    for name, val in ranked:
        sign = "+" if val >= 0 else "-"
        out.append(f"{name}: {sign}{abs(val):.2f}")
    return out

def ensure_form(df: pd.DataFrame) -> pd.DataFrame:

    df = df.copy()
    if "form" in df.columns and df["form"].notna().any():
        df["form"] = _to_num(df["form"]).fillna(0.0)
        return df
    if not {"element","kickoff_time","total_points"}.issubset(df.columns):
        df["form"] = 0.0
        return df
    df.sort_values(["element","kickoff_time"], inplace=True)
    def _compute(g: pd.DataFrame) -> pd.DataFrame:
        pts = g[["kickoff_time","total_points"]].copy()
        pts["total_points"] = _to_num(pts["total_points"]).fillna(0.0)
        out = []
        for t in g["kickoff_time"]:
            if pd.isna(t):
                out.append(0.0); continue
            mask = (pts["kickoff_time"] < t) & (pts["kickoff_time"] >= (t - pd.Timedelta(days=30)))
            window = pts.loc[mask, "total_points"]
            matches = int(mask.sum())
            out.append(float(window.sum())/matches if matches>0 else 0.0)
        g=g.copy(); g["form"]=out; return g
    df = df.groupby("element", group_keys=False).apply(_compute)
    df["form"] = df["form"].fillna(0.0).astype(float)
    return df

def choose_features(df: pd.DataFrame) -> List[str]:
    candidates = [c for c in df.columns if c not in LEAKAGE_COLS]
    exclude = {"name","team","position","element","fixture","opponent_team","kickoff_time","season"}
    return [c for c in PREFERRED_FEATURES if (c in candidates and c not in exclude)]

def build_feature_frame(df: pd.DataFrame, feature_whitelist: List[str]) -> Tuple[pd.DataFrame, List[str]]:
    df = df.copy()
    df["pos_num"] = df["position"].map(POS_MAP).fillna(0).astype(int)
    avail = [c for c in feature_whitelist if c in df.columns]
    features = ["pos_num"] + avail
    X = df[features].copy()
    for c in X.columns:
        if X[c].dtype == object and c != "pos_num":
            X[c] = _to_num(X[c])
    if "was_home" in X.columns:
        X["was_home"] = X["was_home"].fillna(False).astype(int)
    X = X.fillna(0.0)
    return X, features[1:]

def map_team_name_to_id(teams_df: pd.DataFrame) -> Dict[str,int]:
    return {row["name"]: int(row["id"]) for _,row in teams_df.iterrows()
            if pd.notna(row.get("name")) and pd.notna(row.get("id"))}

def team_id_to_name(teams_df: pd.DataFrame) -> Dict[int,str]:
    return {int(row["id"]): row["name"] for _,row in teams_df.iterrows()
            if pd.notna(row.get("name")) and pd.notna(row.get("id"))}

def attach_next_fixture_context(curr_latest_df: pd.DataFrame, fixtures: pd.DataFrame,
                                teams: pd.DataFrame, next_gw: int) -> pd.DataFrame:
    curr = curr_latest_df.copy()
    name_to_id = map_team_name_to_id(teams)
    id_to_name = team_id_to_name(teams)

    curr["team_id"] = curr["team"].map(name_to_id)
    fxgw = fixtures.loc[fixtures.get("event").eq(next_gw)].copy()
    for c in ["team_h","team_a","team_h_difficulty","team_a_difficulty","event"]:
        if c in fxgw.columns:
            fxgw[c] = _to_num(fxgw[c])

    def _find(row):
        tid = row["team_id"]
        if pd.isna(tid):
            return pd.Series({"next_opponent": None, "next_opponent_difficulty": np.nan, "next_was_home": np.nan})
        tid = int(tid)
        match = fxgw[(fxgw["team_h"]==tid) | (fxgw["team_a"]==tid)]
        if match.empty:
            return pd.Series({"next_opponent": None, "next_opponent_difficulty": np.nan, "next_was_home": np.nan})
        m = match.iloc[0]
        if int(m["team_h"]) == tid:
            opp_id = int(m["team_a"]); opp = id_to_name.get(opp_id, str(opp_id))
            diff = float(m.get("team_h_difficulty", np.nan)); was_home=True
        else:
            opp_id = int(m["team_h"]); opp = id_to_name.get(opp_id, str(opp_id))
            diff = float(m.get("team_a_difficulty", np.nan)); was_home=False
        return pd.Series({"next_opponent": opp, "next_opponent_difficulty": diff, "next_was_home": was_home})

    out = curr.apply(_find, axis=1)
    return pd.concat([curr, out], axis=1)

def order_key_name(df: pd.DataFrame) -> str | None:
    if "kickoff_time" in df.columns and df["kickoff_time"].notna().any():
        return "kickoff_time"
    if "GW" in df.columns:
        return "GW"
    return None

def make_sequences(df_all: pd.DataFrame, X_all: pd.DataFrame, y_all: pd.Series,
                   min_len: int = MIN_SEQ_LEN) -> Tuple[List[np.ndarray], List[np.ndarray], List[Dict]]:

    meta_cols = {}
    if "element" in df_all.columns:  meta_cols["element"] = df_all["element"].values
    if "name" in df_all.columns:     meta_cols["name"]    = df_all["name"].values
    if "team" in df_all.columns:     meta_cols["team"]    = df_all["team"].values
    if "position" in df_all.columns: meta_cols["position"]= df_all["position"].values

    if "kickoff_time" in df_all.columns:
        meta_cols[META_KO] = pd.to_datetime(df_all["kickoff_time"], errors="coerce", utc=True).values
    else:
        meta_cols[META_KO] = pd.Series([pd.NaT]*len(df_all), dtype="datetime64[ns, UTC]").values

    if "GW" in df_all.columns:
        meta_cols[META_GW] = pd.to_numeric(df_all["GW"], errors="coerce").values
    else:
        meta_cols[META_GW] = np.full(len(df_all), np.nan, dtype=float)

    meta_df = pd.DataFrame(meta_cols)
    y_col = pd.Series(y_all, name="_y").reset_index(drop=True)

    df_aug = pd.concat(
        [meta_df.reset_index(drop=True), X_all.reset_index(drop=True), y_col],
        axis=1
    )

    X_cols = X_all.columns.tolist()
    X_seqs, y_seqs, meta = [], [], []

    for el, g in df_aug.groupby("element"):
        by = []
        if META_KO in g.columns and pd.notna(g[META_KO]).any():
            by.append(META_KO)
        if META_GW in g.columns and pd.to_numeric(g[META_GW], errors="coerce").notna().any():
            by.append(META_GW)

        if by:
            g = g.sort_values(by=by, na_position="last").reset_index(drop=True)
        else:
            g = g.reset_index(drop=True)

        if len(g) < min_len:
            continue

        X_seq = g[X_cols].values.astype(np.float32)
        y_seq = pd.to_numeric(g["_y"], errors="coerce").fillna(0.0).values.astype(np.float32)

        last_gw_series = pd.to_numeric(g[META_GW], errors="coerce").dropna()
        last_gw = int(last_gw_series.iat[-1]) if not last_gw_series.empty else None

        X_seqs.append(X_seq)
        y_seqs.append(y_seq)
        meta.append({
            "element": int(el) if pd.notna(el) else -1,
            "name": str(g["name"].iat[-1]) if "name" in g else "",
            "team": str(g["team"].iat[-1]) if "team" in g else "",
            "position": str(g["position"].iat[-1]) if "position" in g else "",
            "last_gw": last_gw,
        })

    return X_seqs, y_seqs, meta

def pad_collate(batch):

    lens = [b[0].shape[0] for b in batch]
    D = batch[0][0].shape[1]
    T = max(lens)
    B = len(batch)
    X_pad = np.zeros((B, T, D), dtype=np.float32)
    y_pad = np.zeros((B, T), dtype=np.float32)
    mask = np.zeros((B, T), dtype=np.float32)
    for i, (x, y) in enumerate(batch):
        L = x.shape[0]
        X_pad[i, :L, :] = x
        y_pad[i, :L] = y
        mask[i, :L] = 1.0
    return (
        torch.tensor(X_pad, dtype=torch.float32),
        torch.tensor(y_pad, dtype=torch.float32),
        torch.tensor(mask, dtype=torch.float32),
        torch.tensor(lens, dtype=torch.long),
    )

class SeqDataset(torch.utils.data.Dataset):
    def __init__(self, X_seqs: List[np.ndarray], y_seqs: List[np.ndarray]):
        self.X = X_seqs
        self.y = y_seqs
    def __len__(self):
        return len(self.X)
    def __getitem__(self, idx):
        return self.X[idx], self.y[idx]

class LSTMRegressor(nn.Module):
    def __init__(self, in_dim: int, hidden: int = 128, layers: int = 2, dropout: float = 0.2):
        super().__init__()
        self.lstm = nn.LSTM(
            input_size=in_dim,
            hidden_size=hidden,
            num_layers=layers,
            batch_first=True,
            dropout=dropout if layers > 1 else 0.0,
        )
        self.head = nn.Linear(hidden, 1)

    def forward(self, x, lengths):
        packed = torch.nn.utils.rnn.pack_padded_sequence(
            x, lengths.cpu(), batch_first=True, enforce_sorted=False
        )
        out_packed, _ = self.lstm(packed)
        out, _ = torch.nn.utils.rnn.pad_packed_sequence(out_packed, batch_first=True)
        yhat = self.head(out).squeeze(-1)
        return yhat

# --------- Train / Eval helpers ---------
def masked_mae(pred: torch.Tensor, true: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    diff = torch.abs(pred - true) * mask
    denom = torch.clamp(mask.sum(), min=1.0)
    return diff.sum() / denom

def train_epochs(model, train_loader, val_loader, epochs, patience, lr, weight_decay):
    model.to(DEVICE)
    opt = optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
    best_mae, best_state, bad = float("inf"), None, 0
    t0 = time.perf_counter()

    for ep in range(1, epochs + 1):
        model.train()
        loss_sum, batches = 0.0, 0

        for Xb, yb, mb, lens in train_loader:
            Xb, yb, mb = Xb.to(DEVICE), yb.to(DEVICE), mb.to(DEVICE)
            pred = model(Xb, lens)
            loss = masked_mae(pred, yb, mb)
            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            opt.step()

            loss_sum += float(loss.item())
            batches += 1

        train_mae_epoch = loss_sum / max(1, batches)

        val_mae = eval_last_step_mae(model, val_loader)

        if val_mae + 1e-6 < best_mae:
            best_mae = val_mae
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            bad = 0
        else:
            bad += 1

        if ep == 1 or ep % VERBOSE_EVERY == 0 or bad == 0:
            elapsed = time.perf_counter() - t0
            print(
                f"[LSTM] epoch {ep:3d}/{epochs}  "
                f"train_mae≈{train_mae_epoch:.4f}  val_mae={val_mae:.4f}  "
                f"best={best_mae:.4f}  bad={bad}/{patience}  "
                f"lr={opt.param_groups[0]['lr']:.2e}  elapsed={elapsed:6.1f}s"
            )
            sys.stdout.flush()

        if bad >= patience:
            break

    if best_state is not None:
        model.load_state_dict({k: v.to(DEVICE) for k, v in best_state.items()})
    return best_mae

def eval_last_step_mae(model, loader) -> float:
    model.eval()
    preds = []
    trues = []
    with torch.no_grad():
        for Xb, yb, mb, lens in loader:
            Xb = Xb.to(DEVICE)
            yb = yb.to(DEVICE)
            yhat = model(Xb, lens)  # [B,T]
            for i, L in enumerate(lens):
                preds.append(float(yhat[i, L - 1].item()))
                trues.append(float(yb[i, L - 1].item()))
    return float(np.mean(np.abs(np.array(preds) - np.array(trues)))) if preds else float("inf")

def grad_input_contrib_last_step(model, x_seq: np.ndarray, feature_names: List[str]) -> Dict[str, float]:

    model_was_training = model.training
    model.eval()  

    T, D = x_seq.shape

    with torch.set_grad_enabled(True):
        with torch.backends.cudnn.flags(enabled=False):
            x = torch.tensor(x_seq[None, :, :], dtype=torch.float32, device=DEVICE, requires_grad=True)  # [1,T,D]
            lengths = torch.tensor([T], dtype=torch.long, device=DEVICE)
            yhat = model(x, lengths)            # [1,T]
            y_last = yhat[0, T - 1: T]          # [1]
            y_last.backward(torch.ones_like(y_last))
            grad = x.grad.detach().cpu().numpy()[0]                       # [T,D]
            contrib = grad[-1] * x.detach().cpu().numpy()[0][-1]          # last step only, [D]

    model.train(model_was_training)

    return {feature_names[i]: float(contrib[i]) for i in range(D)}

def main():
    set_seed(SEED)

    # Load
    hist = normalize_columns(read_csv_safe(HISTORICAL_CSV))
    curr = normalize_columns(read_csv_safe(CURRENT_CSV))
    fix  = normalize_columns(read_csv_safe(FIXTURES_CSV))
    teams = normalize_columns(read_csv_safe(TEAMS_CSV))

    hist = ensure_form(hist)
    curr = ensure_form(curr)

    if "GW" not in curr.columns:
        raise SystemExit("current_data.csv must contain a 'GW' column.")
    if "total_points" not in hist.columns or "total_points" not in curr.columns:
        raise SystemExit("Both historical_data.csv and current_data.csv must have 'total_points'.")

    latest_gw = int(curr["GW"].max())
    next_gw = latest_gw + 1

    train_df = pd.concat(
        [
            hist.assign(__source="historical"),
            curr[curr["GW"] <= latest_gw].assign(__source="current"),
        ],
        ignore_index=True,
    )
    train_df = train_df[pd.notna(train_df["total_points"])].copy()
    valid_df = curr[curr["GW"] == latest_gw].copy()

    feature_list = choose_features(train_df)
    X_train_df, feature_cols_wo_pos = build_feature_frame(train_df, feature_list)
    y_train = _to_num(train_df["total_points"]).fillna(0.0)

    X_seqs_train, y_seqs_train, meta_train = make_sequences(train_df, X_train_df, y_train)

    curr_upto = curr[curr["GW"] <= latest_gw].copy()
    X_valid_df, _ = build_feature_frame(curr_upto, feature_list)
    y_valid_series = _to_num(curr_upto["total_points"]).fillna(0.0)
    X_seqs_valid, y_seqs_valid, meta_valid = make_sequences(curr_upto, X_valid_df, y_valid_series)

    scaler = StandardScaler()
    if not X_seqs_train:
        raise SystemExit("No training sequences found; check your data.")
    X_concat_for_fit = np.vstack(X_seqs_train)
    scaler.fit(X_concat_for_fit)

    X_seqs_train = [scaler.transform(x) for x in X_seqs_train]
    X_seqs_valid = [scaler.transform(x) for x in X_seqs_valid]

    train_loader = torch.utils.data.DataLoader(
        SeqDataset(X_seqs_train, y_seqs_train), batch_size=BATCH_SIZE, shuffle=True, collate_fn=pad_collate
    )
    val_loader = torch.utils.data.DataLoader(
        SeqDataset(X_seqs_valid, y_seqs_valid), batch_size=BATCH_SIZE, shuffle=False, collate_fn=pad_collate
    )

    in_dim = X_seqs_train[0].shape[1]
    model = LSTMRegressor(in_dim=in_dim, hidden=128, layers=2, dropout=0.20)

    best_val_mae = train_epochs(model, train_loader, val_loader, EPOCHS, PATIENCE, LR, WEIGHT_DECAY)
    print(f"[LSTM Validation] GW={latest_gw} MAE: {best_val_mae:.3f}")

    validation_mae = round(float(best_val_mae), 4)


    base_pred = curr[curr["GW"] == latest_gw].copy()
    base_pred = attach_next_fixture_context(base_pred, fix, teams, next_gw)

    base_pred["was_home"] = np.where(
        base_pred["next_was_home"].isin([True, False]),
        base_pred["next_was_home"],
        base_pred.get("was_home", False),
    )

    X_hist_all_df, _ = build_feature_frame(train_df, feature_list)
    y_hist_all = _to_num(train_df["total_points"]).fillna(0.0)
    X_hist_seqs, y_hist_seqs, meta_hist = make_sequences(train_df, X_hist_all_df, y_hist_all)

    el_to_seq = {}
    for (Xseq, Yseq, m) in zip(X_hist_seqs, y_hist_seqs, meta_hist):
        el_to_seq[m["element"]] = (Xseq, m)

    rows = []

    feat_with_pos = ["pos_num"] + feature_cols_wo_pos

    for _, row in base_pred.iterrows():
        el = int(row["element"]) if pd.notna(row.get("element")) else None
        if el is None or el not in el_to_seq:
            continue

        Xseq, m = el_to_seq[el]

        sort_key = order_key_name(train_df)
        subset = train_df[train_df["element"] == el]
        if sort_key is not None:
            by = [sort_key]
            if sort_key == "kickoff_time" and "GW" in subset.columns:
                by.append("GW")
            latest_row = subset.sort_values(by=by, na_position="last").iloc[-1]
        else:
            latest_row = subset.iloc[-1]
        latest_feat_row = {}
        for fn in feat_with_pos:
            val = latest_row.get(fn, 0.0)
            if pd.isna(val): val = 0.0
            latest_feat_row[fn] = float(val)

        if "was_home" in latest_feat_row:
            latest_feat_row["was_home"] = 1.0 if bool(row.get("was_home", latest_feat_row["was_home"])) else 0.0
        if "GW" in latest_feat_row:
            latest_feat_row["GW"] = float(next_gw)
        if "round" in latest_feat_row:
            latest_feat_row["round"] = float(next_gw)

        x_next = np.array([latest_feat_row[fn] if fn in latest_feat_row else 0.0 for fn in feat_with_pos], dtype=np.float32)

        X_seq_full = np.vstack([Xseq, x_next[None, :]])
        X_seq_full_std = scaler.transform(X_seq_full)

        model.eval()
        with torch.no_grad():
            x_t = torch.tensor(X_seq_full_std[None, :, :], dtype=torch.float32, device=DEVICE)
            lengths = torch.tensor([X_seq_full_std.shape[0]], dtype=torch.long, device=DEVICE)
            yhat = model(x_t, lengths)
            pred_next = float(yhat[0, -1].item())

        contrib = grad_input_contrib_last_step(model, X_seq_full_std, feat_with_pos)
        top = top_k(contrib, k=4)
        top_txt = ", ".join(top)

        pos = str(row.get("position", ""))
        was_home = bool(row.get("was_home", False))
        opp = row.get("next_opponent", "TBD")
        diff = row.get("next_opponent_difficulty")
        form_val = float(row.get("form", 0.0))
        explanation = (
            f"{pos} vs {opp} ({'H' if was_home else 'A'}, "
            f"diff {int(diff) if pd.notna(diff) else '?'}). "
            f"Form {form_val:.2f}. Top drivers: {top_txt}."
        )

        rows.append({
            "name": row.get("name", ""),
            "element": el,
            "team": row.get("team", ""),
            "position": row.get("position", ""),
            "predicted_total_points": round(pred_next, 2),
            "next_opponent": opp,
            "next_gameweek": next_gw,
            "next_opponent_difficulty": np.round(diff if pd.notna(diff) else np.nan, 0),
            "top_factors": top_txt,
            "explanation": explanation,
            "validation_mae": validation_mae,
            "model": "lstm",
        })

    if not rows:
        raise SystemExit("No predictions produced; check data alignment and element IDs.")

    out = pd.DataFrame(rows)
    out = out.sort_values(by="predicted_total_points", ascending=False).reset_index(drop=True)

    cols = [
        "name","element","team","position","predicted_total_points",
        "next_opponent","next_gameweek","next_opponent_difficulty",
        "top_factors","explanation","validation_mae","model"
    ]
    out = out[cols]
    out.to_csv(f"{OUTPUT_DIR}/predicted_{MODEL}.csv", index=False)
    print(f"Wrote predicted_{MODEL}.csv")

if __name__ == "__main__":
    main()

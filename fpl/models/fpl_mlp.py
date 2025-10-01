#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations
from pathlib import Path
from typing import List, Dict, Tuple
import warnings
warnings.filterwarnings("ignore", category=UserWarning)
import time, sys
import numpy as np
import pandas as pd
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

MODEL = "mlp"

VERBOSE_EVERY = 1
SEED = 1337
EPOCHS = 500
BATCH_SIZE = 256
LR = 3e-3
WEIGHT_DECAY = 1e-4
PATIENCE = 40

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

LEAKAGE_COLS = {
    "total_points", "team_a_score", "team_h_score",
    "goals_scored", "assists", "saves",
    "yellow_cards", "red_cards", "own_goals",
    "bonus", "bps", "xP",
    "clean_sheets", "minutes",
    "transfers_in", "transfers_out", "transfers_balance",
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
    "value",
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
    return {int(r["id"]): r["name"] for _,r in teams_df.iterrows()
            if pd.notna(r.get("name")) and pd.notna(r.get("id"))}

def attach_next_fixture_context(curr_latest_df: pd.DataFrame, fixtures: pd.DataFrame,
                                teams: pd.DataFrame, next_gw: int) -> pd.DataFrame:
    curr = curr_latest_df.copy()
    id_to_name = map_team_name_to_id(teams)
    name_to_id = {v:k for k,v in id_to_name.items()}
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

def top_k(items: Dict[str,float], k=4) -> List[str]:
    ranked = sorted(items.items(), key=lambda kv: -abs(kv[1]))[:k]
    res=[]
    for name,val in ranked:
        sign = "+" if val>=0 else "-"
        res.append(f"{name}: {sign}{abs(val):.2f}")
    return res

class MLP(nn.Module):
    def __init__(self, in_dim: int):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(in_dim, 256),
            nn.ReLU(),
            nn.BatchNorm1d(256),
            nn.Dropout(0.15),
            nn.Linear(256, 128),
            nn.ReLU(),
            nn.BatchNorm1d(128),
            nn.Dropout(0.10),
            nn.Linear(128, 1),
        )
    def forward(self, x):  # x: [B, D]
        return self.net(x).squeeze(-1)  # [B]

def mae_np(a, b) -> float:
    return float(np.mean(np.abs(a - b)))

def train_model(model, X_tr, y_tr, X_va, y_va):
    model.to(DEVICE)
    crit = nn.L1Loss()
    opt = optim.AdamW(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)

    best_mae = float("inf"); best_state=None; bad=0
    n = X_tr.shape[0]
    idx = np.arange(n)
    t0 = time.perf_counter()

    for ep in range(EPOCHS):
        model.train()
        np.random.shuffle(idx)
        for i in range(0, n, BATCH_SIZE):
            sl = idx[i:i+BATCH_SIZE]
            xb = torch.tensor(X_tr[sl], dtype=torch.float32, device=DEVICE)
            yb = torch.tensor(y_tr[sl], dtype=torch.float32, device=DEVICE)
            opt.zero_grad()
            pred = model(xb)
            loss = crit(pred, yb)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            opt.step()

        model.eval()
        with torch.no_grad():
            xv = torch.tensor(X_va, dtype=torch.float32, device=DEVICE)
            pv = model(xv).cpu().numpy()
        val_mae = mae_np(pv, y_va)
        if val_mae + 1e-6 < best_mae:
            best_mae = val_mae
            best_state = {k: v.cpu().clone() for k,v in model.state_dict().items()}
            bad = 0
        else:
            bad += 1
        
        if ep == 1 or ep % VERBOSE_EVERY == 0 or bad == 0:
            elapsed = time.perf_counter() - t0
            print(
                f"[MLP] epoch {ep:3d}/{EPOCHS}  "
                f"val_mae={val_mae:.4f}  "
                f"best={best_mae:.4f}  bad={bad}/{PATIENCE}  "
                f"lr={opt.param_groups[0]['lr']:.2e}  elapsed={elapsed:6.1f}s"
            )
            sys.stdout.flush()

        if bad >= PATIENCE:
            break

    if best_state is not None:
        model.load_state_dict({k: v.to(DEVICE) for k,v in best_state.items()})
    return best_mae

def grad_input_contrib_per_row(model, x_row: np.ndarray, feature_names: List[str]) -> Dict[str, float]:

    model.eval()
    x = torch.tensor(x_row[None, :], dtype=torch.float32, device=DEVICE, requires_grad=True)
    y = model(x)  # [1]
    y.backward(torch.ones_like(y))
    grad = x.grad.detach().cpu().numpy()[0]  # [D]
    contrib = grad * x.detach().cpu().numpy()[0]
    return {feature_names[i]: float(contrib[i]) for i in range(len(feature_names))}

def main():
    set_seed(SEED)

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
        [hist.assign(__source="historical"),
         curr[curr["GW"] <= latest_gw].assign(__source="current")],
        ignore_index=True,
    )
    train_df = train_df[pd.notna(train_df["total_points"])].copy()
    valid_df = curr[curr["GW"] == latest_gw].copy()

    feature_list = choose_features(train_df)
    X_train_df, feature_cols_wo_pos = build_feature_frame(train_df, feature_list)
    y_train = _to_num(train_df["total_points"]).fillna(0.0).astype(float).values

    X_valid_df, _ = build_feature_frame(valid_df, feature_list)
    y_valid = _to_num(valid_df["total_points"]).fillna(0.0).astype(float).values

    feature_names_with_pos = ["pos_num"] + feature_cols_wo_pos

    scaler = StandardScaler()
    X_train = scaler.fit_transform(X_train_df.values)
    X_valid = scaler.transform(X_valid_df.values)

    model = MLP(in_dim=X_train.shape[1])
    best_mae = train_model(model, X_train, y_train, X_valid, y_valid)
    print(f"[NN Validation] GW={latest_gw} MAE: {best_mae:.3f} on {len(y_valid)} rows")
    validation_mae = round(float(best_mae), 4)

    base_pred = curr[curr["GW"] == latest_gw].copy()
    base_pred = attach_next_fixture_context(base_pred, fix, teams, next_gw)

    base_pred["was_home"] = np.where(
        base_pred["next_was_home"].isin([True, False]),
        base_pred["next_was_home"],
        base_pred.get("was_home", False),
    )

    X_pred_df, _ = build_feature_frame(base_pred, feature_list)
    X_pred = scaler.transform(X_pred_df.values)

    model.eval()
    with torch.no_grad():
        preds = model(torch.tensor(X_pred, dtype=torch.float32, device=DEVICE)).cpu().numpy()

    contribs_txt = []
    for i in range(X_pred.shape[0]):
        contrib = grad_input_contrib_per_row(model, X_pred[i], feature_names_with_pos)
        top = top_k(contrib, k=4)
        contribs_txt.append(", ".join(top))

    combined = base_pred.copy()
    combined["predicted_total_points"] = preds
    combined["top_factors"] = contribs_txt

    def _explain(row):
        pos = str(row.get("position", ""))
        was_home = bool(row.get("was_home", False))
        opp = row.get("next_opponent", "TBD")
        diff = row.get("next_opponent_difficulty")
        form_val = float(row.get("form", 0.0))
        return (f"{pos} vs {opp} ({'H' if was_home else 'A'}, "
                f"diff {int(diff) if pd.notna(diff) else '?'}). "
                f"Form {form_val:.2f}. Top drivers: {row.get('top_factors','')}.")
    combined["explanation"] = combined.apply(_explain, axis=1)

    out = combined[[
        "name","element","team","position","predicted_total_points","next_opponent"
    ]].copy()
    out["next_gameweek"] = next_gw
    out["next_opponent_difficulty"] = np.round(combined["next_opponent_difficulty"], 0)
    out["top_factors"] = combined["top_factors"]
    out["explanation"] = combined["explanation"]
    out["validation_mae"] = validation_mae
    out["model"] = MODEL

    out["predicted_total_points"] = np.round(out["predicted_total_points"], 2)
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

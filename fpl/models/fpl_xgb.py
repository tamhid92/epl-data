#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations
from pathlib import Path
from typing import List, Dict, Tuple
import warnings
warnings.filterwarnings("ignore", category=UserWarning)

import numpy as np
import pandas as pd

try:
    import xgboost as xgb
except Exception as e:
    raise SystemExit("XGBoost is required. Install with: pip install xgboost") from e

from configparser import ConfigParser
config = ConfigParser()
config.read("config.ini")

OUTPUT_DIR     = config.get("DATA_DIRS","OUT_DIR")
HISTORICAL_CSV = config.get("DATA_DIRS","HISTORICAL_CSV")
CURRENT_CSV    = config.get("DATA_DIRS","CURRENT_CSV")
FIXTURES_CSV   = config.get("DATA_DIRS","FIXTURES_CSV")
TEAMS_CSV      = config.get("DATA_DIRS","TEAMS_CSV")

MODEL = "xgb"

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
    """
    If 'form' exists we keep it (e.g., from FPL bootstrap). Otherwise, compute 30d rolling:
    sum(total_points in last 30d) / matches in last 30d, per element.
    """
    df = df.copy()
    if "form" in df.columns and df["form"].notna().any():
        df["form"] = _to_num(df["form"]).fillna(0.0)
        return df

    required = {"element", "kickoff_time", "total_points"}
    if not required.issubset(df.columns):
        df["form"] = 0.0
        return df

    df.sort_values(["element", "kickoff_time"], inplace=True)

    def _compute_group(g: pd.DataFrame) -> pd.DataFrame:
        pts = g[["kickoff_time", "total_points"]].copy()
        pts["total_points"] = _to_num(pts["total_points"]).fillna(0.0)
        out = []
        for t in g["kickoff_time"]:
            if pd.isna(t):
                out.append(0.0)
                continue
            mask = (pts["kickoff_time"] < t) & (pts["kickoff_time"] >= (t - pd.Timedelta(days=30)))
            window = pts.loc[mask, "total_points"]
            matches = int(mask.sum())
            out.append(float(window.sum()) / matches if matches > 0 else 0.0)
        g = g.copy()
        g["form"] = out
        return g

    df = df.groupby("element", group_keys=False).apply(_compute_group)
    df["form"] = df["form"].fillna(0.0).astype(float)
    return df

def choose_features(df: pd.DataFrame) -> List[str]:
    candidates = [c for c in df.columns if c not in LEAKAGE_COLS]
    exclude = {"name", "team", "position", "element", "fixture", "opponent_team", "kickoff_time", "season"}
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

def map_team_name_to_id(teams_df: pd.DataFrame) -> Dict[str, int]:
    return {row["name"]: int(row["id"]) for _, row in teams_df.iterrows()
            if pd.notna(row.get("name")) and pd.notna(row.get("id"))}

def team_id_to_name(teams_df: pd.DataFrame) -> Dict[int, str]:
    return {int(row["id"]): row["name"] for _, row in teams_df.iterrows()
            if pd.notna(row.get("name")) and pd.notna(row.get("id"))}

def attach_next_fixture_context(curr_latest_df: pd.DataFrame, fixtures: pd.DataFrame,
                                teams: pd.DataFrame, next_gw: int) -> pd.DataFrame:
    curr = curr_latest_df.copy()
    name_to_id = map_team_name_to_id(teams)
    id_to_name = team_id_to_name(teams)

    curr["team_id"] = curr["team"].map(name_to_id)
    fxgw = fixtures.loc[fixtures.get("event").eq(next_gw)].copy()

    for c in ["team_h", "team_a", "team_h_difficulty", "team_a_difficulty", "event"]:
        if c in fxgw.columns:
            fxgw[c] = _to_num(fxgw[c])

    def _find(row):
        tid = row["team_id"]
        if pd.isna(tid):
            return pd.Series({"next_opponent": None, "next_opponent_difficulty": np.nan, "next_was_home": np.nan})
        tid = int(tid)
        match = fxgw[(fxgw["team_h"] == tid) | (fxgw["team_a"] == tid)]
        if match.empty:
            return pd.Series({"next_opponent": None, "next_opponent_difficulty": np.nan, "next_was_home": np.nan})
        m = match.iloc[0]
        if int(m["team_h"]) == tid:
            opp_id = int(m["team_a"])
            opp_name = id_to_name.get(opp_id, str(opp_id))
            diff = float(m.get("team_h_difficulty", np.nan))
            was_home = True
        else:
            opp_id = int(m["team_h"])
            opp_name = id_to_name.get(opp_id, str(opp_id))
            diff = float(m.get("team_a_difficulty", np.nan))
            was_home = False
        return pd.Series({"next_opponent": opp_name, "next_opponent_difficulty": diff, "next_was_home": was_home})

    out = curr.apply(_find, axis=1)
    curr = pd.concat([curr, out], axis=1)
    return curr

def top_factors_from_contrib(contrib: np.ndarray, feature_names_with_pos: List[str], k: int = 4) -> List[str]:
    vals = contrib[:-1]
    idx = np.argsort(-np.abs(vals))[:k]
    items = []
    for i in idx:
        sign = "+" if vals[i] >= 0 else "-"
        items.append(f"{feature_names_with_pos[i]}: {sign}{abs(vals[i]):.2f}")
    return items

def main():
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
    X_train, feature_cols_wo_pos = build_feature_frame(train_df, feature_list)
    y_train = _to_num(train_df["total_points"]).fillna(0.0).astype(float)

    X_valid, _ = build_feature_frame(valid_df, feature_list)
    y_valid = _to_num(valid_df["total_points"]).fillna(0.0).astype(float)

    feature_names_with_pos = ["pos_num"] + feature_cols_wo_pos

    mono = []
    for fn in feature_names_with_pos:
        mono.append(1 if fn == "form" else 0)
    monotone_constraint_str = "(" + ",".join(str(v) for v in mono) + ")"

    dtrain = xgb.DMatrix(X_train.values, label=y_train, feature_names=feature_names_with_pos)
    dvalid = xgb.DMatrix(X_valid.values,  label=y_valid,  feature_names=feature_names_with_pos)

    params = {
        "objective": "reg:squarederror",
        "eval_metric": "mae",
        "eta": 0.05,
        "max_depth": 8,
        "subsample": 0.8,
        "colsample_bytree": 0.9,
        "min_child_weight": 20,
        "lambda": 1.0,
        "alpha": 0.0,
        "monotone_constraints": monotone_constraint_str,
        "verbosity": 0,
    }

    evals = [(dtrain, "train"), (dvalid, "valid")]
    booster = xgb.train(
        params,
        dtrain,
        num_boost_round=3000,
        evals=evals,
        early_stopping_rounds=200,
        verbose_eval=False,
    )

    pred_valid = booster.predict(dvalid, iteration_range=(0, booster.best_iteration + 1))
    mae = float(np.mean(np.abs(pred_valid - y_valid)))
    print(f"[XGB Validation] GW={latest_gw} MAE: {mae:.3f} on {len(y_valid)} rows")
    validation_mae = round(mae, 4)

    base_pred = curr[curr["GW"] == latest_gw].copy()
    base_pred = attach_next_fixture_context(base_pred, fix, teams, next_gw)

    base_pred["was_home"] = np.where(
        base_pred["next_was_home"].isin([True, False]),
        base_pred["next_was_home"],
        base_pred.get("was_home", False),
    )

    X_pred, _ = build_feature_frame(base_pred, feature_list)
    dpred = xgb.DMatrix(X_pred.values, feature_names=feature_names_with_pos)

    preds = booster.predict(dpred, iteration_range=(0, booster.best_iteration + 1))
    contribs = booster.predict(dpred, pred_contribs=True, iteration_range=(0, booster.best_iteration + 1))

    combined = base_pred.copy()
    combined["predicted_total_points"] = preds
    combined["_contribs"] = list(contribs) 

    def _row_expl(row):
        c = row["_contribs"]
        topk_list = top_factors_from_contrib(c, feature_names_with_pos, k=4)
        pos = str(row.get("position", ""))
        was_home = bool(row.get("was_home", False))
        opp = row.get("next_opponent", "TBD")
        diff = row.get("next_opponent_difficulty")
        form_val = float(row.get("form", 0.0))

        explanation = (
            f"{pos} vs {opp} ({'H' if was_home else 'A'}, "
            f"diff {int(diff) if pd.notna(diff) else '?'}). "
            f"Form {form_val:.2f}. Top drivers: {', '.join(topk_list)}."
        )
        return pd.Series({
            "top_factors": ", ".join(topk_list),
            "explanation": explanation,
        })

    combined = pd.concat([combined, combined.apply(_row_expl, axis=1)], axis=1)

    out = combined[[
        "name", "element", "team", "position",
        "predicted_total_points", "next_opponent",
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
        "top_factors","explanation", "validation_mae", "model"
    ]
    out = out[cols]
    out.to_csv(f"{OUTPUT_DIR}/predicted_{MODEL}.csv", index=False)
    print(f"Wrote predicted_{MODEL}.csv")

if __name__ == "__main__":
    main()

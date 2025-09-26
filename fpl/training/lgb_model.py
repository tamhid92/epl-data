#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
LightGBM — Position-aware FPL points predictor (train on historical, validate on current)
with per-position CALIBRATION + configurable SCALERS/MODIFIERS loaded from a config file.

Output schema:
  name, element, team, position, predicted_total_points,
  next_opponent, next_gameweek, next_opponent_difficulty, top_factors, explanation
"""

from __future__ import annotations

import argparse
from pathlib import Path
import warnings
warnings.filterwarnings("ignore", category=UserWarning)

import numpy as np
import pandas as pd
from typing import List, Dict, Tuple, Any

# LightGBM
try:
    import lightgbm as lgb
except Exception as e:
    raise SystemExit("LightGBM is required. Install with: pip install lightgbm") from e

from sklearn.metrics import mean_absolute_error

# ---------- Config loader (TOML or JSON; YAML optional if installed) ----------
def load_config(path: Path) -> Dict[str, Any]:
    suffix = path.suffix.lower()
    if suffix in (".toml",):
        try:
            import tomllib  # py3.11+
        except Exception:
            import tomli as tomllib  # pip install tomli for py<3.11
        with open(path, "rb") as f:
            return tomllib.load(f)
    elif suffix in (".json",):
        import json
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    elif suffix in (".yml", ".yaml"):
        try:
            import yaml  # pip install pyyaml
        except Exception as e:
            raise SystemExit("YAML config requires PyYAML (pip install pyyaml).") from e
        with open(path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f)
    else:
        raise SystemExit(f"Unsupported config extension: {suffix}. Use .toml or .json (or .yaml).")

# ----------------------------
# Constants / config defaults
# ----------------------------

# LEAKAGE_COLS = {
#     "total_points", "team_a_score", "team_h_score",
#     "goals_scored", "assists", "saves", "yellow_cards", "red_cards",
#     "own_goals", "goals_conceded", "clean_sheets", "bonus", "bps",
#     "goals_scored_gw", "assists_gw", "saves_gw", "yellow_cards_gw",
#     "red_cards_gw", "bonus_gw", "bps_gw", "own_goals_gw",
#     "kickoff_time", "minutes",
#     "xP",
# }
LEAKAGE_COLS = {"bps"}
DISALLOWED_FEATURE_NAMES = {"xp", "expected_points", "predicted_points"}
IDENT_KEYS = {
    "element","name","team","position","fixture","id","event","gameweek","gameweek_num",
    "season","opponent_team","team_h","team_a","team_id__teams","team_name__teams",
}
TEAM_NAME_KEY  = "name"
TEAM_SHORT_KEY = "short_name"
TEAM_ID_KEY    = "id"
POSITIONS = ["GK","DEF","MID","FWD"]

LGB_DEFAULTS = dict(
    objective="regression",
    metric="l1",
    n_estimators=1400,
    learning_rate=0.03,
    num_leaves=63,
    max_depth=-1,
    subsample=0.85,
    colsample_bytree=0.85,
    reg_alpha=0.1,
    reg_lambda=0.2,
    random_state=42,
    force_row_wise=True,
    verbosity=-1,
)

# ----------------------------
# I/O + small utils
# ----------------------------

def read_csv_safe(p: Path) -> pd.DataFrame:
    if not p.exists():
        raise FileNotFoundError(f"Missing file: {p}")
    return pd.read_csv(p)

def drop_junk_cols(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty: return df
    mask = df.columns.str.match(r"^Unnamed", na=False)
    return df.loc[:, ~mask].copy()

def coerce_element(df: pd.DataFrame) -> pd.DataFrame:
    if "element" in df.columns:
        df["element"] = pd.to_numeric(df["element"], errors="coerce").astype("Int64")
    return df

def coerce_datetime(df: pd.DataFrame, col: str) -> pd.DataFrame:
    if col in df.columns:
        df[col] = pd.to_datetime(df[col], errors="coerce", utc=True)
    return df

def time_order(df: pd.DataFrame) -> pd.DataFrame:
    if "kickoff_time" in df.columns:
        return df.sort_values("kickoff_time")
    elif {"season","gameweek"}.issubset(df.columns):
        return df.sort_values(["season","gameweek"])
    return df.sort_index()

# ----------------------------
# Enrichment: strengths, difficulty, scoring, lagged features
# ----------------------------

def add_team_strengths(players_df: pd.DataFrame, teams_df: pd.DataFrame) -> pd.DataFrame:
    tcols = [c for c in teams_df.columns if c.startswith("strength")]
    keep = [TEAM_NAME_KEY, TEAM_ID_KEY] + tcols
    teams_slim = teams_df[keep].copy()
    teams_slim.columns = [ "team_name__teams", "team_id__teams"] + tcols
    out = players_df.merge(teams_slim, left_on="team", right_on="team_name__teams", how="left")

    opp = teams_df[[TEAM_ID_KEY] + tcols].copy()
    opp.columns = ["opponent_team",] + [f"opp_{c}" for c in tcols]
    out = out.merge(opp, on="opponent_team", how="left")
    return out

def add_fixture_difficulty(players_df: pd.DataFrame, fixtures_df: pd.DataFrame) -> pd.DataFrame:
    fcols = ["id", "team_h", "team_a", "team_h_difficulty", "team_a_difficulty", "event", "kickoff_time"]
    f = fixtures_df[fcols].copy()
    out = players_df.merge(f, left_on="fixture", right_on="id", how="left", suffixes=("", "_fx"))
    def pick_diff(row):
        if pd.isna(row.get("was_home")):
            return np.nan
        return row.get("team_h_difficulty") if bool(row.get("was_home")) else row.get("team_a_difficulty")
    out["fixture_difficulty_pov"] = out.apply(pick_diff, axis=1)
    return out

GOAL_MULT = {"GK": 10.0, "DEF": 6.0, "MID": 5.0, "FWD": 4.0}
CS_POINTS = {"GK": 4.0, "DEF": 4.0, "MID": 1.0, "FWD": 0.0}

def add_scoring_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    pos = df.get("position", pd.Series(index=df.index, dtype=object)).astype(str).str.upper().str[:3]
    xG  = pd.to_numeric(df.get("expected_goals", np.nan), errors="coerce")
    xA  = pd.to_numeric(df.get("expected_assists", np.nan), errors="coerce")
    xGC = pd.to_numeric(df.get("expected_goals_conceded", np.nan), errors="coerce")

    goal_mult = pos.map(GOAL_MULT)
    cs_pts    = pos.map(CS_POINTS)

    df["goal_points_expect"]   = xG * goal_mult
    df["assist_points_expect"] = xA * 3.0

    with np.errstate(over="ignore", under="ignore", invalid="ignore"):
        cs_prob = np.exp(-xGC)
    df["cs_points_expect"] = cs_prob * cs_pts

    gc_penalty_base = -0.5 * xGC
    df["gc_penalty_points_expect"] = np.where(pos.isin(["GK","DEF"]), gc_penalty_base, np.nan)

    df["scoring_expect_sum"] = df[[
        "goal_points_expect","assist_points_expect","cs_points_expect","gc_penalty_points_expect"
    ]].sum(axis=1, skipna=True)
    return df

def add_pov_difficulty_strength(df: pd.DataFrame) -> pd.DataFrame:
    d = df.copy()
    d["difficulty_pov"] = pd.to_numeric(d.get("opponent_team_difficulty", np.nan), errors="coerce")
    if "fixture_difficulty_pov" in d.columns:
        d["difficulty_pov"] = d["difficulty_pov"].fillna(pd.to_numeric(d["fixture_difficulty_pov"], errors="coerce"))
    d["opponent_team_difficulty_sq"] = d["difficulty_pov"]**2

    soh = pd.to_numeric(d.get("strength_overall_home", np.nan), errors="coerce")
    soa = pd.to_numeric(d.get("strength_overall_away", np.nan), errors="coerce")
    was_home = d.get("was_home")
    if was_home is not None:
        mask = was_home.astype(str).str.lower().isin({"true","1","t","yes"})
        d["team_strength_overall_pov"] = np.where(mask, soh, soa)
    else:
        d["team_strength_overall_pov"] = np.nan
    return d

def _safe_num_col(df: pd.DataFrame, col: str):
    return pd.to_numeric(df.get(col, np.nan), errors="coerce")

def add_lagged_form_features(df: pd.DataFrame) -> pd.DataFrame:
    """Past-only rolling signals per player (shifted by 1)."""
    d = df.copy()
    if "kickoff_time" in d.columns:
        d["_t"] = pd.to_datetime(d["kickoff_time"], errors="coerce")
    else:
        d["_t"] = pd.to_numeric(d.get("gameweek", np.nan), errors="coerce")

    d["_tp"]  = _safe_num_col(d, "total_points")
    d["_xg"]  = _safe_num_col(d, "expected_goals")
    d["_xa"]  = _safe_num_col(d, "expected_assists")
    d["_mins"]= _safe_num_col(d, "minutes")
    d["_st"]  = _safe_num_col(d, "starts") if "starts" in d.columns else (d["_mins"] > 0).astype(float)

    d = coerce_element(d).sort_values(["element","_t"])

    def roll3(s: pd.Series) -> pd.Series:
        return s.shift(1).rolling(3, min_periods=1).mean()

    d["form_points_roll3"] = d.groupby("element")["_tp"].transform(roll3)
    xgi = (d["_xg"].fillna(0) + d["_xa"].fillna(0))
    d["xgi_roll3"] = xgi.groupby(d["element"]).transform(roll3)
    d["minutes_roll3"] = d.groupby("element")["_mins"].transform(roll3)
    d["starts_roll3"]  = d.groupby("element")["_st"].transform(roll3)

    for base_col, ser in {
        "ict_index": _safe_num_col(d, "ict_index"),
        "creativity": _safe_num_col(d, "creativity"),
        "threat": _safe_num_col(d, "threat"),
        "influence": _safe_num_col(d, "influence"),
        "expected_goals": d["_xg"],
        "expected_assists": d["_xa"],
    }.items():
        d[f"{base_col}_roll3"] = ser.groupby(d["element"]).transform(roll3)

    return d.drop(columns=["_t","_tp","_xg","_xa","_mins"], errors="ignore")

# ----------------------------
# Feature selection + encoding
# ----------------------------

def build_feature_list(train_cols, predict_cols, extra_feats, train_df=None):
    inter = set(train_cols).intersection(set(predict_cols))
    def ok(name: str) -> bool:
        if name in LEAKAGE_COLS: return False
        if name in IDENT_KEYS: return False
        low = (name or "").strip().lower()
        if low in DISALLOWED_FEATURE_NAMES: return False
        if low.startswith("unnamed"): return False
        if low.startswith("_"): return False
        return True
    feats = sorted([c for c in inter if ok(c)])
    for ef in extra_feats:
        if ef in inter and ok(ef) and ef not in feats:
            feats.append(ef)
    if train_df is not None and not train_df.empty:
        keep = []
        for c in feats:
            s = pd.to_numeric(train_df.get(c), errors="coerce")
            if s.notna().any() and s.nunique(dropna=True) > 1:
                keep.append(c)
        feats = keep
    return feats

TRUE_SET = {"true","1","t","y","yes","on"}
FALSE_SET = {"false","0","f","n","no","off"}

def _is_boolish_series(s: pd.Series) -> bool:
    if pd.api.types.is_bool_dtype(s): return True
    if pd.api.types.is_numeric_dtype(s):
        vals = pd.unique(s.dropna())
        return len(vals) <= 2 and set(vals).issubset({0,1})
    if pd.api.types.is_object_dtype(s) or pd.api.types.is_categorical_dtype(s):
        sample = s.dropna().astype(str).str.lower().unique()
        if len(sample) == 0: return False
        return set(sample).issubset(TRUE_SET.union(FALSE_SET))
    return False

def _to_bool_float(s: pd.Series) -> pd.Series:
    if pd.api.types.is_bool_dtype(s):
        return s.astype("float32")
    if pd.api.types.is_numeric_dtype(s):
        return s.astype("float32").where(s.isna(), (s != 0).astype("float32"))
    m = s.astype(str).str.lower()
    out = pd.Series(np.nan, index=s.index, dtype="float32")
    out = out.where(~m.isin(TRUE_SET.union(FALSE_SET)),
                    m.isin(TRUE_SET).astype("float32"))
    return out

def learn_categorical_encoders(train_df: pd.DataFrame, feature_cols: List[str]):
    encoders = {}
    for col in feature_cols:
        s = train_df[col] if col in train_df.columns else pd.Series(dtype=float)
        if _is_boolish_series(s):
            encoders[col] = {"type": "bool"}
        elif pd.api.types.is_numeric_dtype(s):
            encoders[col] = {"type": "numeric"}
        else:
            uniques = pd.unique(s.dropna())
            mapping = {val: i for i, val in enumerate(uniques)}
            encoders[col] = {"type": "cat", "map": mapping}
    return encoders

def apply_encoders(df: pd.DataFrame, feature_cols: List[str], encoders: dict) -> pd.DataFrame:
    out = df[feature_cols].copy()
    for col in feature_cols:
        info = encoders[col]
        if info["type"] == "numeric":
            out[col] = pd.to_numeric(out[col], errors="coerce")
        elif info["type"] == "bool":
            out[col] = _to_bool_float(out[col])
        elif info["type"] == "cat":
            mapping = info["map"]
            out[col] = out[col].map(mapping).astype("float32")
        else:
            out[col] = pd.to_numeric(out[col], errors="coerce")
    return out

# ----------------------------
# Monotone constraints
# ----------------------------

_FORM_KEYS = [
    "form_points_roll3", "xgi_roll3", "minutes_roll3", "starts_roll3",
    "ict_index_roll3", "creativity_roll3", "threat_roll3", "influence_roll3",
    "expected_goals_roll3", "expected_assists_roll3",
    "goal_points_expect", "assist_points_expect",
    "form",
]
_DIFF_KEYS = [
    "difficulty_pov", "opponent_team_difficulty", "fixture_difficulty_pov",
    "opponent_team_difficulty_sq"
]
_TEAM_STRENGTH_KEYS = [
    "team_strength_overall_pov", "strength_overall_home", "strength_overall_away"
]

def make_monotone_constraints_for_pos(pos: str, features: List[str]) -> List[int]:
    cons = []
    for f in features:
        fl = f.lower()
        if any(k in fl for k in _FORM_KEYS) or any(k in fl for k in _TEAM_STRENGTH_KEYS):
            cons.append(1)
        elif any(k in fl for k in _DIFF_KEYS):
            cons.append(-1 if pos in ("GK","DEF") else 0)
        else:
            cons.append(0)
    return cons

# ----------------------------
# SHAP-like pred_contrib → factors
# ----------------------------

READABLE_NAMES = {
    "goal_points_expect": "finishing threat (xG × position points)",
    "assist_points_expect": "creative threat (xA × 3)",
    "cs_points_expect": "clean-sheet potential",
    "gc_penalty_points_expect": "goals-conceded risk",
    "fixture_difficulty_pov": "fixture difficulty",
    "difficulty_pov": "opponent difficulty (POV)",
    "opponent_team_difficulty": "opponent difficulty",
    "opponent_team_difficulty_sq": "opponent difficulty²",
    "team_strength_overall_pov": "team overall strength (POV)",
    "strength_overall_home": "team overall strength (home)",
    "strength_overall_away": "team overall strength (away)",
    "was_home": "home advantage",
    "ict_index": "ICT index",
    "creativity": "creativity",
    "threat": "threat",
    "influence": "influence",
    "expected_goals": "xG",
    "expected_assists": "xA",
    "expected_goals_conceded": "xGC",
    "saves": "saves",
    "form_points_roll3": "recent points (3-match)",
    "xgi_roll3": "recent xGI (3-match)",
    "minutes_roll3": "recent minutes (3-match)",
    "starts_roll3": "recent starts (3-match)",
    "ict_index_roll3": "ICT (3-match)",
    "creativity_roll3": "creativity (3-match)",
    "threat_roll3": "threat (3-match)",
    "influence_roll3": "influence (3-match)",
    "expected_goals_roll3": "xG (3-match)",
    "expected_assists_roll3": "xA (3-match)",
    "form": "raw form",
}

def nice_name(feat: str) -> str:
    return READABLE_NAMES.get(feat, feat.replace("_"," "))

def top_factors(contrib_row: pd.Series, k: int = 5) -> str:
    parts = contrib_row.drop(labels=["bias"])
    top = parts.reindex(parts.abs().sort_values(ascending=False).index)[:k]
    outs = []
    for feat, val in top.items():
        arrow = "↑" if val >= 0 else "↓"
        outs.append(f"{nice_name(feat)} {arrow} ({val:+.2f})")
    return "; ".join(outs)

def explain_player(row: pd.Series, pos: str, opp_short: str | float, pred: float, bias: float, tf: str) -> str:
    diff = row.get("difficulty_pov", np.nan)
    home = row.get("was_home", np.nan)
    venue = "home" if bool(home) else "away" if np.isfinite(home) else "home/away"
    opp_txt = f"vs {opp_short}" if isinstance(opp_short, str) else "next opponent"
    if np.isfinite(diff):
        diff_txt = "favourable" if diff <= 2 else ("tough" if diff >= 4 else "balanced")
    else:
        diff_txt = "unclear"
    return (f"Projected {pred:.2f} pts ({pos}), baseline {bias:.2f}. "
            f"{venue.title()} {opp_txt}, a {diff_txt} fixture. Drivers: {tf}.")

def get_pred_contribs(model: lgb.LGBMRegressor, X: pd.DataFrame) -> Tuple[np.ndarray, pd.DataFrame]:
    contribs = model.predict(X, pred_contrib=True)
    preds = contribs.sum(axis=1)
    cols = list(X.columns) + ["bias"]
    df = pd.DataFrame(contribs, columns=cols, index=X.index)
    return preds, df

# ----------------------------
# Calibration & scalers
# ----------------------------

def _feat_idx_map(feature_names: List[str]) -> Dict[str, int]:
    idx = {}
    for k in ["goal_points_expect","assist_points_expect","cs_points_expect","form","form_points_roll3"]:
        idx[k] = feature_names.index(k) if k in feature_names else -1
    return idx

def _extract_array(dfX: pd.DataFrame, col: str) -> np.ndarray:
    if col in dfX.columns:
        return pd.to_numeric(dfX[col], errors="coerce").fillna(0).to_numpy(np.float32)
    return np.zeros((len(dfX),), dtype=np.float32)

def _extract_channels(dfX: pd.DataFrame) -> Dict[str,np.ndarray]:
    out = {}
    for k in ("goal_points_expect","assist_points_expect","cs_points_expect","form","form_points_roll3"):
        out[k] = _extract_array(dfX, k)
    return out

def _ridge_fit(X: np.ndarray, y: np.ndarray, lam: float = 4.0) -> np.ndarray:
    XT = X.T
    A = XT @ X
    d = A.shape[0]
    A.flat[::d+1] += lam
    b = XT @ y
    try:
        w = np.linalg.solve(A, b)
    except np.linalg.LinAlgError:
        w = np.linalg.lstsq(A, b, rcond=None)[0]
    return w

def _centered_temp_scale(preds: np.ndarray, center: float, temp: float) -> np.ndarray:
    return center + temp * (preds - center)

def _hi_end_compress(preds: np.ndarray, q: float, slope: float) -> np.ndarray:
    if len(preds) == 0: return preds
    t = float(np.quantile(preds, q))
    hi = preds > t
    out = preds.copy()
    out[hi] = t + slope * (preds[hi] - t)
    return out

def _blend(a: np.ndarray, b: np.ndarray, w: float) -> np.ndarray:
    w = float(np.clip(w, 0.0, 1.0))
    return (1.0 - w) * a + w * b

def quantile_rescale_to_target(preds: np.ndarray, y_val: np.ndarray, n_q: int = 9) -> np.ndarray:
    """
    Piecewise-linear quantile mapping: aligns prediction distribution to labels on validation.
    Returns rescaled preds (same order).
    """
    if len(preds) < 20 or len(y_val) < 20:
        return preds
    qps = np.linspace(0.05, 0.95, n_q)
    p_q = np.quantile(preds, qps)
    y_q = np.quantile(y_val, qps)
    # interpolate for each pred
    return np.interp(preds, p_q, y_q, left=y_q[0], right=y_q[-1]).astype(np.float32)

def apply_position_calibration_and_scalers(
    pos: str,
    raw_pred_next: np.ndarray,
    Xpred: pd.DataFrame,
    val_preds: np.ndarray,
    Xval: pd.DataFrame,
    y_val: np.ndarray,
    ytr_center: float,
    cfg: Dict[str, Any],
) -> np.ndarray:
    """
    1) Linear ridge calibration on current (labels) with channels: raw, goal, assist, cs, form.
    2) Position priors (boost attackers, penalize cs for def/gk).
    3) Optional extra penalties for tough away fixtures (def/gk).
    4) Optional post scalers: temperature, high-end compression, mean-shift, global multiplier, hard cap, clipping.
    5) Optional quantile mapping to match validation distribution (then blend).
    """
    # ---- channels
    ch_val = _extract_channels(Xval) if len(y_val) else {k: np.array([]) for k in
        ("goal_points_expect","assist_points_expect","cs_points_expect","form","form_points_roll3")}
    ch_pr  = _extract_channels(Xpred)

    # ---- ridge calibration on current
    preds_cal = raw_pred_next.astype(np.float32)
    use_cal = bool(cfg["calibration"].get("enabled", True))
    lam     = float(cfg["calibration"].get("ridge_lambda", 4.0))
    slope_lo, slope_hi = cfg["calibration"].get("raw_slope_bounds", [0.5, 1.2])
    add_form = bool(cfg["calibration"].get("use_form", True))

    if use_cal and len(y_val) >= int(cfg["calibration"].get("min_val_rows", 100)):
        Xd_parts = [
            np.ones_like(val_preds, dtype=np.float32),
            val_preds.astype(np.float32),
            ch_val["goal_points_expect"].astype(np.float32),
            ch_val["assist_points_expect"].astype(np.float32),
            np.clip(ch_val["cs_points_expect"], 0.0, float(cfg["priors"].get("cs_cap", 1.2))).astype(np.float32),
        ]
        if add_form:
            # prefer raw form, fallback to rolling
            form_va = ch_val["form"] if ch_val["form"].size else ch_val["form_points_roll3"]
            Xd_parts.append(form_va.astype(np.float32))
        Xd = np.column_stack(Xd_parts)
        w = _ridge_fit(Xd, y_val.astype(np.float32), lam=lam)
        # constrain slope on raw to be sane
        w[1] = float(np.clip(w[1], float(slope_lo), float(slope_hi)))

        Xp_parts = [
            np.ones_like(raw_pred_next, dtype=np.float32),
            raw_pred_next.astype(np.float32),
            ch_pr["goal_points_expect"].astype(np.float32),
            ch_pr["assist_points_expect"].astype(np.float32),
            np.clip(ch_pr["cs_points_expect"], 0.0, float(cfg["priors"].get("cs_cap", 1.2))).astype(np.float32),
        ]
        if add_form:
            form_pr = ch_pr["form"] if ch_pr["form"].size else ch_pr["form_points_roll3"]
            Xp_parts.append(form_pr.astype(np.float32))
        Xp = np.column_stack(Xp_parts)
        preds_cal = (Xp @ w).astype(np.float32)

    # ---- position priors
    pri = cfg["priors"]
    if pos in ("MID","FWD"):
        # Additive boost using form + attack channels (configurable)
        preds_cal = preds_cal + float(pri.get("form_boost_midfwd", 0.8)) * (
            ch_pr["form"] if ch_pr["form"].size else ch_pr["form_points_roll3"]
        )
        if pri.get("att_boost_use_xgxa", False):
            preds_cal = preds_cal + float(pri.get("att_boost_midfwd", 0.3)) * (
                ch_pr["goal_points_expect"] + ch_pr["assist_points_expect"]
            )
    else:
        # penalize clean-sheet channel
        cs_cap = float(pri.get("cs_cap", 1.2))
        cs_c   = np.clip(ch_pr["cs_points_expect"], 0.0, cs_cap)
        preds_cal = preds_cal - float(pri.get("cs_penalty_defgk", 0.45)) * cs_c
        # optional away+tough penalty
        tough = pri.get("defgk_tough_penalty", 0.7)
        if tough and "difficulty_pov" in Xpred.columns and "was_home" in Xpred.columns:
            diff = pd.to_numeric(Xpred["difficulty_pov"], errors="coerce").fillna(3).to_numpy()
            was_home = Xpred["was_home"].astype(str).str.lower().isin({"true","1","t","yes"}).to_numpy()
            tough_away = (diff >= float(pri.get("tough_threshold", 4))) & (~was_home)
            preds_cal = preds_cal - float(tough) * tough_away.astype(np.float32)

    # ---- post scalers (order matters)
    sc = cfg["scalers"]
    # Negative clip before scaling (optional)
    if sc.get("pre_clip_zero", True):
        preds_cal = np.maximum(0.0, preds_cal)

    # Temperature (centered on training mean by position)
    temp = float(sc["temperature"].get(pos, sc["temperature"].get("default", 0.9)))
    center = float(ytr_center if np.isfinite(ytr_center) else sc.get("fallback_center", 1.0))
    preds_cal = _centered_temp_scale(preds_cal, center=center, temp=temp)

    # High-end compression
    hec = sc.get("high_end_compression", {})
    q_start = float(hec.get("quantile", 0.75))
    slope   = float(hec.get("slope", 0.65))
    preds_cal = _hi_end_compress(preds_cal, q=q_start, slope=slope)

    # Mean alignment (optional): shift predictions so their mean matches validation mean (per position)
    if sc.get("mean_align", {}).get("enabled", False) and len(y_val) > 0:
        target_mean = float(sc["mean_align"].get("target", float(np.nanmean(y_val))))
        pred_mean   = float(np.nanmean(preds_cal)) if len(preds_cal) else 0.0
        preds_cal = preds_cal + (target_mean - pred_mean)

    # Global multiplier
    gmul = float(sc.get("global_multiplier", 1.0))
    preds_cal = preds_cal * gmul

    # Post hard cap
    cap = float(sc.get("hard_cap", 0.0))
    if cap > 0:
        preds_cal = np.minimum(preds_cal, cap)

    # Final zero clip
    if sc.get("clip_zero", True):
        preds_cal = np.maximum(0.0, preds_cal)

    # ---- optional quantile mapping (then blend)
    qm = cfg.get("quantile_mapping", {})
    if qm.get("enabled", False) and len(y_val) >= int(qm.get("min_val_rows", 200)):
        mapped = quantile_rescale_to_target(preds_cal, y_val, n_q=int(qm.get("n_quantiles", 9)))
        blend_w = float(qm.get("blend_weight", 0.5))  # 0 keeps preds_cal; 1 uses fully mapped
        preds_cal = _blend(preds_cal, mapped, blend_w)

    return preds_cal.astype(np.float32)

# ----------------------------
# Fixtures → synthesize next rows if needed
# ----------------------------

def synthesize_next_rows_from_fixtures(current_df: pd.DataFrame, fixtures_df: pd.DataFrame, next_gw: int) -> pd.DataFrame:
    df = current_df.copy()
    df["gameweek_num"] = pd.to_numeric(df.get("gameweek", np.nan), errors="coerce")
    if "kickoff_time" in df.columns:
        df["kickoff_time_dt"] = pd.to_datetime(df["kickoff_time"], errors="coerce")
        last_rows = df.sort_values(["kickoff_time_dt","gameweek_num"]).groupby("element", as_index=False).tail(1).copy()
    elif "gameweek_num" in df.columns:
        last_rows = df.sort_values(["gameweek_num"]).groupby("element", as_index=False).tail(1).copy()
    else:
        last_rows = df.drop_duplicates("element", keep="last").copy()

    f = fixtures_df.copy()
    f["event"] = pd.to_numeric(f.get("event", np.nan), errors="coerce")
    next_fix = f[f["event"] == next_gw].copy()
    mapping = {}
    for _, r in next_fix.iterrows():
        fid = r.get("id"); th, ta = r.get("team_h"), r.get("team_a")
        dh, da = r.get("team_h_difficulty"), r.get("team_a_difficulty")
        mapping[th] = {"opponent_team": ta, "was_home": True,  "fixture": fid, "fixture_difficulty_pov": dh, "kickoff_time_next": r.get("kickoff_time")}
        mapping[ta] = {"opponent_team": th, "was_home": False, "fixture": fid, "fixture_difficulty_pov": da, "kickoff_time_next": r.get("kickoff_time")}
    def apply_map(row):
        team_id = row.get("team_id__teams")
        info = mapping.get(team_id, None)
        return pd.Series({
            "opponent_team": info.get("opponent_team") if info else np.nan,
            "was_home": info.get("was_home") if info else np.nan,
            "fixture": info.get("fixture") if info else np.nan,
            "fixture_difficulty_pov": info.get("fixture_difficulty_pov") if info else np.nan,
            "kickoff_time": info.get("kickoff_time_next") if info else row.get("kickoff_time", np.nan)
        })
    mapped = last_rows.apply(apply_map, axis=1)
    synth = last_rows.copy()
    synth[["opponent_team","was_home","fixture","fixture_difficulty_pov","kickoff_time"]] = mapped
    synth["gameweek"] = next_gw
    synth["gameweek_num"] = next_gw
    return coerce_element(synth)

# ----------------------------
# Main
# ----------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", type=str, default="data/")
    ap.add_argument("--output", type=str, default="lgbm_predicted_next_gw.csv")
    ap.add_argument("--config", type=str, required=True, help="Path to config TOML/JSON/YAML")
    args = ap.parse_args()

    cfg = load_config(Path(args.config))

    # LightGBM params (allow override from config)
    lgb_params = {**LGB_DEFAULTS, **cfg.get("lightgbm", {})}

    wd = Path(args.workdir).resolve()
    historical = drop_junk_cols(coerce_element(read_csv_safe(wd/"historical_data.csv")))
    current    = drop_junk_cols(coerce_element(read_csv_safe(wd/"current_data.csv")))
    teams      = drop_junk_cols(read_csv_safe(wd/"teams.csv"))
    fixtures   = drop_junk_cols(read_csv_safe(wd/"fixtures.csv"))

    for df in (historical, current):
        coerce_datetime(df, "kickoff_time")

    # enrich
    historical = add_team_strengths(historical, teams)
    historical = add_fixture_difficulty(historical, fixtures)
    current    = add_team_strengths(current, teams)
    current    = add_fixture_difficulty(current, fixtures)

    historical = add_scoring_features(historical)
    current    = add_scoring_features(current)

    historical = add_pov_difficulty_strength(historical)
    current    = add_pov_difficulty_strength(current)

    historical = add_lagged_form_features(historical)
    current    = add_lagged_form_features(current)

    # Determine next GW
    if "gameweek" not in current.columns:
        raise ValueError("current_data.csv must include 'gameweek'.")
    gw_numeric = pd.to_numeric(current["gameweek"], errors="coerce")
    max_gw  = int(gw_numeric.max())
    next_gw = max_gw + 1

    current["gameweek_num"] = pd.to_numeric(current["gameweek"], errors="coerce")
    next_rows = current[current["gameweek_num"] == next_gw].copy()
    if next_rows.empty:
        hist_for_pred = pd.concat([historical, current[current["gameweek_num"] <= max_gw]], ignore_index=True)
        df_for_syn = current.copy()
        if "team_id__teams" not in df_for_syn.columns or df_for_syn["team_id__teams"].isna().any():
            name_to_id = dict(zip(teams[TEAM_NAME_KEY], teams[TEAM_ID_KEY]))
            df_for_syn["team_id__teams"] = df_for_syn.get("team_id__teams").fillna(df_for_syn["team"].map(name_to_id))
        next_rows = synthesize_next_rows_from_fixtures(df_for_syn, fixtures, next_gw)
    else:
        hist_for_pred = pd.concat([historical, current[current["gameweek_num"] <= max_gw]], ignore_index=True)

    # Feature list
    extra_feats = cfg.get("features", {}).get("extra", [
        "difficulty_pov","opponent_team_difficulty","opponent_team_difficulty_sq",
        "team_strength_overall_pov","strength_overall_home","strength_overall_away",
        "was_home",
        "fixture_difficulty_pov",
        "goal_points_expect","assist_points_expect","cs_points_expect","gc_penalty_points_expect","scoring_expect_sum",
        "form_points_roll3","xgi_roll3","minutes_roll3","starts_roll3",
        "ict_index_roll3","creativity_roll3","threat_roll3","influence_roll3","expected_goals_roll3","expected_assists_roll3",
        "expected_goals","expected_assists","expected_goals_conceded","saves",
        "form",
    ])
    FEATURES = build_feature_list(historical.columns.tolist(), current.columns.tolist(), extra_feats, train_df=historical)
    print(f"[{len(FEATURES)}] features in use. Example: {FEATURES[:10]}")

    # Encoders learned on TRAIN ONLY
    encoders = learn_categorical_encoders(historical, FEATURES)

    # Opponent label map
    if TEAM_SHORT_KEY in teams.columns:
        opp_name_map = dict(zip(teams[TEAM_ID_KEY], teams[TEAM_SHORT_KEY]))
    else:
        opp_name_map = dict(zip(teams[TEAM_ID_KEY], teams[TEAM_NAME_KEY]))

    outputs = []

    for pos in POSITIONS:
        print(f"=== LightGBM Training {pos} (train=historical, val=current) ===")
        train_pos = historical[historical["position"].astype(str).str.upper().str[:3] == pos].copy()
        val_pos   = current[current["position"].astype(str).str.upper().str[:3] == pos].copy()

        # labels
        ytr = pd.to_numeric(train_pos["total_points"], errors="coerce")
        train_pos = train_pos[ytr.notna()].copy()
        ytr = pd.to_numeric(train_pos["total_points"], errors="coerce")

        # matrices
        Xtr = apply_encoders(train_pos, FEATURES, encoders).fillna(0.0)

        # monotone constraints (optional per config)
        if cfg.get("monotone", {}).get("enabled", True):
            mono = make_monotone_constraints_for_pos(pos, FEATURES)
        else:
            mono = [0]*len(FEATURES)
        params = {**lgb_params, "monotone_constraints": mono}

        # validation on CURRENT labeled rows
        val_pos_lab = val_pos[pd.to_numeric(val_pos["total_points"], errors="coerce").notna()].copy()
        yva = pd.to_numeric(val_pos_lab["total_points"], errors="coerce")
        Xva = apply_encoders(val_pos_lab, FEATURES, encoders).fillna(0.0)

        if Xtr.empty:
            print(f"[{pos}] No training rows; skipping.")
            continue

        ordered_idx = time_order(train_pos).index
        Xtr = Xtr.loc[ordered_idx]; ytr = ytr.loc[ordered_idx]

        # train + early stopping vs current val if available
        model = lgb.LGBMRegressor(**params)
        if len(ytr) >= int(cfg.get("training", {}).get("min_rows_for_es", 500)) and not Xva.empty:
            model.fit(
                Xtr, ytr,
                eval_set=[(Xva, yva)] if len(yva) > 0 else None,
                eval_metric="l1",
                callbacks=[lgb.early_stopping(stopping_rounds=int(cfg.get("training", {}).get("early_stop_rounds", 120)), verbose=False)]
            )
            best_n = model.best_iteration_ or params["n_estimators"]
        else:
            model.fit(Xtr, ytr)
            best_n = params["n_estimators"]

        # final refit on all historical
        model = lgb.LGBMRegressor(**{**params, "n_estimators": best_n})
        model.fit(Xtr, ytr)

        # report val
        if not Xva.empty and len(yva) > 0:
            pred_va = model.predict(Xva, num_iteration=best_n)
            mae = mean_absolute_error(yva, pred_va)
            print(f"[{pos}] Val MAE on CURRENT: {mae:.3f} (rows train={len(ytr)}, val={len(yva)})")
        else:
            pred_va = np.array([]); yva = np.array([])

        # Build prediction rows
        next_pos = next_rows[next_rows["position"].astype(str).str.upper().str[:3] == pos].copy()
        if next_pos.empty:
            print(f"[{pos}] No next rows; skipping.")
            continue
        Xpred = apply_encoders(next_pos, FEATURES, encoders).fillna(0.0)

        raw_pred = model.predict(Xpred, num_iteration=best_n)

        # Per-position calibration + scalers (all via cfg)
        ytr_center = float(np.nanmean(ytr.values)) if len(ytr) else float(cfg.get("scalers", {}).get("fallback_center", 1.0))
        preds_final = apply_position_calibration_and_scalers(
            pos=pos,
            raw_pred_next=raw_pred,
            Xpred=Xpred,
            val_preds=pred_va,
            Xval=Xva,
            y_val=yva.values if len(yva) else np.array([]),
            ytr_center=ytr_center,
            cfg=cfg,
        )

        # Explanations
        _, contribs_df = get_pred_contribs(model, Xpred)
        bias = float(contribs_df["bias"].iloc[0]) if "bias" in contribs_df.columns and len(contribs_df) > 0 else 0.0

        tmp = next_pos.copy()
        tmp["predicted_total_points"] = preds_final
        tmp["next_opponent"] = tmp["opponent_team"].map(opp_name_map)
        tmp["next_gameweek"] = next_gw
        tmp["next_opponent_difficulty"] = tmp.get("difficulty_pov", tmp.get("fixture_difficulty_pov", np.nan))

        tops, exps = [], []
        for i, row in tmp.iterrows():
            c_row = contribs_df.iloc[tmp.index.get_loc(i)]
            tf = top_factors(c_row, k=int(cfg.get("explanations", {}).get("top_k", 5)))
            exps.append(explain_player(row, pos, row.get("next_opponent"), float(tmp.loc[i,"predicted_total_points"]), bias, tf))
            tops.append(tf)
        tmp["top_factors"] = tops
        tmp["explanation"] = exps

        outputs.append(tmp[[
            "name","element","team","position",
            "predicted_total_points",
            "next_opponent","next_gameweek","next_opponent_difficulty",
            "top_factors","explanation"
        ]])

    out = (pd.concat(outputs, ignore_index=True).sort_values("predicted_total_points", ascending=False)
           if outputs else pd.DataFrame(columns=[
               "name","element","team","position","predicted_total_points",
               "next_opponent","next_gameweek","next_opponent_difficulty","top_factors","explanation"
           ]))

    Path(args.output).resolve().parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(Path(args.output).resolve(), index=False)
    print(f"[next_gw={next_gw}] Rows predicted: {len(out)}  |  Features used: {len(FEATURES)}")

    if len(out) > 0 and bool(cfg.get("explanations", {}).get("print_samples", True)):
        print("\n--- Sample explanations (LightGBM + calibrated + scaled) ---")
        for i, r in out.head(int(cfg.get("explanations", {}).get("samples", 5))).iterrows():
            print(f"{i+1}. {r['name']} ({r['position']}) vs {r['next_opponent']}: {r['predicted_total_points']:.2f} pts")
            print(f"   Factors: {r['top_factors']}")
            print(f"   Why: {r['explanation']}\n")

if __name__ == "__main__":
    main()

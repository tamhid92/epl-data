from __future__ import annotations
import argparse, sys, math, time
from typing import Dict, List, Tuple
import requests
import pandas as pd
import numpy as np
from pathlib import Path

MODELS = ["lstm", "mlp", "lgb", "xgb"]
FPL_EVENT_LIVE = "https://fantasy.premierleague.com/api/event/{gw}/live/"
FPL_BOOTSTRAP = "https://fantasy.premierleague.com/api/bootstrap-static/"
PREDS_BASE = "http://epl-api:8000"

def fetch_json(url: str, timeout: int = 30) -> dict:
    r = requests.get(url, timeout=timeout)
    r.raise_for_status()
    return r.json()

def get_predictions(pred_base, model, API_TOKEN):

    headers = {
        "X-API-Key": API_TOKEN,
        "Accept": "application/json"
    }
    url = f"{pred_base.rstrip('/')}/fpl_predict_last{model}"
    data = fetch_json(url, headers=headers)
    df = pd.DataFrame(data)

    if "element" not in df.columns or "predicted_total_points" not in df.columns:
        raise ValueError(f"{model} endpoint missing required fields 'element' or 'predicted_total_points'")
    df["element"] = pd.to_numeric(df["element"], errors="coerce").astype("Int64")
    df["predicted_total_points"] = pd.to_numeric(df["predicted_total_points"], errors="coerce")

    if "position" in df.columns:
        df["position"] = df["position"].astype("string")
    else:
        df["position"] = pd.Series([pd.NA]*len(df), dtype="string")
    df["model"] = model
    return df[["element", "predicted_total_points", "position", "model"]].dropna(subset=["element", "predicted_total_points"])

def get_actuals(gw: int) -> pd.DataFrame:
    data = fetch_json(FPL_EVENT_LIVE.format(gw=gw))
    elems = data.get("elements", [])
    rows = []
    for e in elems:
        eid = e.get("id")
        stats = e.get("stats", {})
        total_points = stats.get("total_points")
        if eid is not None and total_points is not None:
            rows.append({"element": int(eid), "total_points": float(total_points)})
    df = pd.DataFrame(rows)
    if df.empty:
        raise ValueError("No actuals found in FPL event live payload.")
    return df

def metrics(y_true: np.ndarray, y_pred: np.ndarray) -> Dict[str, float]:
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    n = y_true.size
    mae  = np.mean(np.abs(y_true - y_pred)) if n else np.nan
    rmse = math.sqrt(np.mean((y_true - y_pred)**2)) if n else np.nan
    bias = float(np.mean(y_pred - y_true)) if n else np.nan
    # R^2 (if variance present)
    var = np.var(y_true)
    r2 = 1.0 - (np.sum((y_true - y_pred)**2) / np.sum((y_true - np.mean(y_true))**2)) if var > 1e-12 else np.nan
    # Pearson
    if n > 1 and np.std(y_true) > 1e-12 and np.std(y_pred) > 1e-12:
        pearson = float(np.corrcoef(y_true, y_pred)[0,1])
    else:
        pearson = np.nan
    # Spearman
    try:
        ranks_true = pd.Series(y_true).rank(method="average")
        ranks_pred = pd.Series(y_pred).rank(method="average")
        if n > 1 and ranks_true.std() > 1e-12 and ranks_pred.std() > 1e-12:
            spearman = float(np.corrcoef(ranks_true, ranks_pred)[0,1])
        else:
            spearman = np.nan
    except Exception:
        spearman = np.nan
    return {
        "n": n,
        "mae": mae,
        "rmse": rmse,
        "bias": bias,
        "r2": r2,
        "pearson_r": pearson,
        "spearman_rho": spearman,
    }

def topk_hits(df: pd.DataFrame, k_list: List[int] = [10, 20]) -> Dict[str, float]:
    out = {}
    if df.empty:
        for k in k_list:
            out[f"top{k}_hitrate"] = np.nan
        return out
    dfp = df.sort_values("predicted_total_points", ascending=False)
    dfa = df.sort_values("total_points", ascending=False)
    for k in k_list:
        k = min(k, len(df))
        pred_ids = set(dfp.head(k)["element"].tolist())
        act_ids  = set(dfa.head(k)["element"].tolist())
        inter = len(pred_ids & act_ids)
        out[f"top{k}_hitrate"] = inter / float(k) if k else np.nan
    return out

def evaluate_model(df_pred: pd.DataFrame, df_actual: pd.DataFrame, model: str, gw: int):
    merged = df_pred.merge(df_actual, on="element", how="inner", validate="many_to_one")
    coverage = len(merged) / len(df_actual) if len(df_actual) else np.nan
    m = metrics(merged["total_points"].values, merged["predicted_total_points"].values)
    m["coverage"] = coverage

    per_pos = (
        merged.groupby("position", dropna=False)[["predicted_total_points","total_points"]]
        .apply(lambda s: float(np.mean(np.abs(s["total_points"] - s["predicted_total_points"]))))
    )
    merged2 = merged.copy()
    merged2["error"] = merged2["predicted_total_points"] - merged2["total_points"]
    merged2 = merged2.sort_values("total_points", ascending=False)
    out_csv = f"gw{gw}_residuals_{model}.csv"
    merged2.to_csv(out_csv, index=False)

    tk = topk_hits(merged)

    for pos, val in per_pos.items():
        pos_key = "unknown" if pd.isna(pos) else str(pos)
        m[f"mae_pos_{pos_key}"] = float(val)

    m.update({k: float(v) for k, v in tk.items()})
    return m

def main(engine, API_TOKEN):
    fpl_data = requests.get(FPL_BOOTSTRAP).json()
    

    for event in fpl_data['events']:
        if not event.get("finished"):
            gw = event.get('id') - 1
            break

    print(f"Fetching actuals for GW {gw} …")
    actual_df = get_actuals(gw)

    summaries = []
    for model in MODELS:
        try:
            print(f"\nFetching predictions: {model}")
            pred_df = get_predictions(PREDS_BASE, model, API_TOKEN)
            print(f"  Rows: {len(pred_df)} (unique elements: {pred_df['element'].nunique()})")
            m = evaluate_model(pred_df, actual_df, model, gw)
            row = {"model": model, **m}
            summaries.append(row)
            print(f"  MAE:   {m['mae']:.3f} | RMSE: {m['rmse']:.3f} | Bias: {m['bias']:.3f} | R²: {m['r2'] if not np.isnan(m['r2']) else float('nan'):.3f}")
            print(f"  ρ:     {m['spearman_rho'] if not np.isnan(m['spearman_rho']) else float('nan'):.3f} | r: {m['pearson_r'] if not np.isnan(m['pearson_r']) else float('nan'):.3f}")
            print(f"  Top10 hitrate: {m.get('top10_hitrate', np.nan):.2%} | Top20 hitrate: {m.get('top20_hitrate', np.nan):.2%}")
            print(f"  Coverage (joined/actuals): {m['coverage']:.2%}")
        except Exception as e:
            print(f"[ERROR] {model}: {e}", file=sys.stderr)

    if summaries:
        summary_df = pd.DataFrame(summaries)
        summary_path = f"gw{gw}_summary.csv"
        summary_df.to_csv(summary_path, index=False)
        summary_df.to_sql("prediction_summary", con=engine, if_exists='replace')

        cols_order = ["model","n","coverage","mae","rmse","bias","r2","pearson_r","spearman_rho","top10_hitrate","top20_hitrate"]
        existing = [c for c in cols_order if c in summary_df.columns]
        print("\n=== Summary ===")
        print(summary_df[existing].sort_values("mae").to_string(index=False))
    
    else:
        print("No summaries produced (all models failed?).", file=sys.stderr)

if __name__ == "__main__":
    main()

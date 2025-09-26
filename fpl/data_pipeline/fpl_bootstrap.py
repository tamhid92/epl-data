#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations
import argparse
import json
from typing import Any, Dict, Iterable

import pandas as pd
import numpy as np
import requests
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.dialects.postgresql import JSONB


FPL_BOOTSTRAP_URL = "https://fantasy.premierleague.com/api/bootstrap-static/"

SQL_FUNCTION = r"""
CREATE OR REPLACE FUNCTION fpl_bootstrap()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
SELECT jsonb_build_object(
  'total_players',
    COALESCE((SELECT total_players FROM fpl_bootstrap_raw LIMIT 1), 0),

  'events',
    COALESCE(
      (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id)
       FROM fpl_events e),
      '[]'::jsonb
    ),

  'game_settings',
    COALESCE(
      (SELECT settings FROM fpl_game_settings LIMIT 1),
      '{}'::jsonb
    ),

  'phases',
    COALESCE(
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id)
       FROM fpl_phases p),
      '[]'::jsonb
    ),

  'teams',
    COALESCE(
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id)
       FROM fpl_teams t),
      '[]'::jsonb
    ),

  'element_stats',
    COALESCE(
      (SELECT jsonb_agg(to_jsonb(es) ORDER BY es.name)
       FROM fpl_element_stats es),
      '[]'::jsonb
    ),

  'element_types',
    COALESCE(
      (SELECT jsonb_agg(to_jsonb(et) ORDER BY et.id)
       FROM fpl_element_types et),
      '[]'::jsonb
    ),

  'elements',
    COALESCE(
      (SELECT jsonb_agg(to_jsonb(el) ORDER BY el.id)
       FROM fpl_elements_enriched el),
      '[]'::jsonb
    )
);
$$;
"""

def get_engine(conn_str) -> Engine:
    return create_engine(conn_str, future=True, pool_pre_ping=True)

# ---------------------- Fetch ----------------------
def fetch_bootstrap() -> Dict[str, Any]:
    r = requests.get(FPL_BOOTSTRAP_URL, timeout=60)
    r.raise_for_status()
    return r.json()

def to_df(items: Any) -> pd.DataFrame:
    if not items:
        return pd.DataFrame()
    return pd.json_normalize(items)

# ---------------------- JSON cleaners ----------------------


def to_python_scalar(x: Any) -> Any:
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.floating,)):
        # convert nan to None handled by is_missing earlier; here just cast
        return float(x)
    if isinstance(x, (np.bool_,)):
        return bool(x)
    if isinstance(x, pd.Timestamp):
        return x.isoformat()
    return x

def is_scalar(x: Any) -> bool:
    if isinstance(x, (list, tuple, set, dict)):
        return False
    try:
        return np.isscalar(x) or isinstance(x, (pd.Timestamp, type(None)))
    except Exception:
        return not isinstance(x, (list, tuple, set, dict, np.ndarray))

def is_missing(x: Any) -> bool:
    if x is None:
        return True
    if not is_scalar(x):
        return False
    try:
        # pd.isna on scalars returns a single boolean
        return bool(pd.isna(x))
    except Exception:
        return False

def deep_clean_json(obj: Any) -> Any:
    # arrays first: convert to list and recurse
    if isinstance(obj, np.ndarray):
        return [deep_clean_json(v) for v in obj.tolist()]

    if is_missing(obj):
        return None

    if is_scalar(obj):
        return to_python_scalar(obj)

    if isinstance(obj, dict):
        return {str(k): deep_clean_json(v) for k, v in obj.items()}

    if isinstance(obj, (list, tuple, set)):
        return [deep_clean_json(v) for v in obj]

    # fallback
    return obj

def coerce_json_cols(df: pd.DataFrame, cols: Iterable[str]) -> pd.DataFrame:
    if df is None or df.empty:
        return df
    df = df.copy()

    def _fix(v):
        if v is None:
            return None
        # ndarray -> list early
        if isinstance(v, np.ndarray):
            v = v.tolist()
        # already a container: clean recursively
        if isinstance(v, (dict, list, tuple, set)):
            return deep_clean_json(v)
        # JSON string?
        if isinstance(v, str) and v.strip().startswith(("{", "[")):
            try:
                return deep_clean_json(json.loads(v))
            except Exception:
                return None
        # scalar: treat NaN/NaT as None; otherwise convert to python scalar
        return None if is_missing(v) else to_python_scalar(v)

    for c in cols:
        if c not in df.columns:
            df[c] = None
        else:
            df[c] = df[c].apply(_fix)
    return df

# ---------------------- Elements normalization ----------------------
def normalize_elements(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df

    known = {
        'id','code','first_name','second_name','web_name','team','team_code','element_type',
        'status','now_cost','value_form','value_season','total_points','event_points','form',
        'points_per_game','selected_by_percent','in_dreamteam','news','news_added','photo',
        'special','minutes','goals_scored','assists','clean_sheets','goals_conceded',
        'own_goals','penalties_saved','penalties_missed','yellow_cards','red_cards','saves',
        'bonus','bps','influence','creativity','threat','ict_index','starts','ep_next','ep_this',
        'can_transact','can_select','removed','squad_number','corners_and_indirect_freekicks_order',
        'corners_and_indirect_freekicks_text','direct_freekicks_order','direct_freekicks_text',
        'penalties_order','penalties_text','region','team_join_date','birth_date','has_temporary_code',
        'opta_code',
        'expected_goals_per_90','expected_assists_per_90','expected_goal_involvements_per_90',
        'expected_goals_conceded_per_90','saves_per_90','goals_conceded_per_90',
        'starts_per_90','clean_sheets_per_90','defensive_contribution_per_90',
        'influence_rank','influence_rank_type','creativity_rank','creativity_rank_type',
        'threat_rank','threat_rank_type','ict_index_rank','ict_index_rank_type',
        'now_cost_rank','now_cost_rank_type','form_rank','form_rank_type',
        'points_per_game_rank','points_per_game_rank_type','selected_rank','selected_rank_type',
    }

    keep = [c for c in df.columns if c in known]
    out = df[keep].copy()

    for col in ("news_added","team_join_date","birth_date"):
        if col in out.columns:
            out[col] = pd.to_datetime(out[col], errors="coerce", utc=True if col=="news_added" else False)

    extra_cols = [c for c in df.columns if c not in known]
    if extra_cols:
        def row_to_extra(r: pd.Series) -> dict:
            d = {k: r[k] for k in extra_cols}
            return deep_clean_json(d)
        out["extra"] = df.apply(row_to_extra, axis=1)
    else:
        out["extra"] = [{} for _ in range(len(out))]

    return out

# ---------------------- Replace-all writer ----------------------
def drop_tables(engine: Engine) -> None:
    tables = [
        "fpl_element_types",
        "fpl_element_stats",
        "fpl_teams",
        "fpl_phases",
        "fpl_game_settings",
        "fpl_events",
        "fpl_bootstrap_raw",
    ]
    with engine.begin() as con:
        for t in tables:
            con.execute(text(f'DROP TABLE IF EXISTS "{t}"'))

def replace_all(engine: Engine, payload: Dict[str, Any]) -> None:
    events_df         = to_df(payload.get("events"))
    game_settings_obj = payload.get("game_settings", {})
    phases_df         = to_df(payload.get("phases"))
    teams_df          = to_df(payload.get("teams"))
    element_stats_df  = to_df(payload.get("element_stats"))
    element_types_df  = to_df(payload.get("element_types"))
    elements_df_raw   = to_df(payload.get("elements"))
    elements_df       = normalize_elements(elements_df_raw)

    if not events_df.empty:
        events_df = coerce_json_cols(events_df, ["chip_plays","top_element_info","overrides_element_types"])
        if "deadline_time" in events_df.columns:
            events_df["deadline_time"] = pd.to_datetime(events_df["deadline_time"], errors="coerce", utc=True)

    elements_df = coerce_json_cols(elements_df, ["extra"])

    drop_tables(engine)
    raw_df = pd.DataFrame([{
        "payload": payload,
        "total_players": payload.get("total_players"),
    }])
    raw_df.to_sql(
        "fpl_bootstrap_raw",
        con=engine,
        if_exists="replace",
        index=False,
        dtype={"payload": JSONB}
    )

    if events_df is None or events_df.empty:
        events_df = pd.DataFrame(columns=["id"])
    events_df.to_sql(
        "fpl_events",
        con=engine,
        if_exists="replace",
        index=False,
        dtype={
            "chip_plays": JSONB,
            "top_element_info": JSONB,
            "overrides_element_types": JSONB
        }
    )
    gs_df = pd.DataFrame([{"settings": deep_clean_json(game_settings_obj)}])
    gs_df.to_sql(
        "fpl_game_settings",
        con=engine,
        if_exists="replace",
        index=False,
        dtype={"settings": JSONB}
    )

    (phases_df if not phases_df.empty else pd.DataFrame()).to_sql(
        "fpl_phases", con=engine, if_exists="replace", index=False
    )
    (teams_df if not teams_df.empty else pd.DataFrame()).to_sql(
        "fpl_teams", con=engine, if_exists="replace", index=False
    )
    (element_stats_df if not element_stats_df.empty else pd.DataFrame()).to_sql(
        "fpl_element_stats", con=engine, if_exists="replace", index=False
    )
    (element_types_df if not element_types_df.empty else pd.DataFrame()).to_sql(
        "fpl_element_types", con=engine, if_exists="replace", index=False
    )

    with engine.begin() as conn:
        conn.exec_driver_sql(SQL_FUNCTION)
    
    print("Created SQL FUNCTION successfully")

def main(conn):

    engine = get_engine(conn)
    payload = fetch_bootstrap()
    replace_all(engine, payload)
    print("Bootstrap replaced successfully.")

def fpl_bootstrap(conn):
    main(conn)

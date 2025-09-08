import os
from typing import Dict, Any, Iterable, List, Tuple
from datetime import datetime

from sqlalchemy import (
    create_engine, MetaData, Table, Column, String, Integer, BigInteger,
    Float, DateTime, Boolean, Text
)
from sqlalchemy.engine import Engine
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import SQLAlchemyError
# -------------------------------------------------------------------
# Connection
# -------------------------------------------------------------------
DB_HOST = os.environ.get("DB_HOST")
DB_PORT = os.environ.get("DB_PORT")
DB_NAME = os.environ.get("DB_NAME")
DB_USER = os.environ.get("DB_USER")
DB_PASS = os.environ.get("DB_PASS")

def get_engine() -> Engine:

    url = f"postgresql+psycopg2://{DB_USER}:{DB_PASS}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
    return create_engine(url, pool_pre_ping=True, future=True)

# -------------------------------------------------------------------
# Schema
# -------------------------------------------------------------------
metadata = MetaData()

match_info = Table(
    "match_info", metadata,
    Column("match_id", BigInteger, primary_key=True),
    Column("fid", BigInteger),
    Column("home_team_id", BigInteger),
    Column("away_team_id", BigInteger),
    Column("date_utc", DateTime),
    Column("league_id", Integer),
    Column("season", Integer),
    Column("home_goals", Integer),
    Column("away_goals", Integer),
    Column("team_h", String(80)),
    Column("team_a", String(80)),
    Column("home_xg", Float),
    Column("away_xg", Float),
    Column("home_win_prob", Float),
    Column("home_draw_prob", Float),
    Column("home_lose_prob", Float),
    Column("league", String(32)),
    Column("home_shots", Integer),
    Column("away_shots", Integer),
    Column("home_shots_on_target", Integer),
    Column("away_shots_on_target", Integer),
    Column("home_deep", Integer),
    Column("away_deep", Integer),
    Column("away_ppda", Float),
    Column("home_ppda", Float),
)

shots_data = Table(
    "shots_data", metadata,
    Column("shot_id", BigInteger, primary_key=True),
    Column("match_id", BigInteger, index=True),
    Column("minute", Integer),
    Column("result", String(32)),
    Column("X", Float),
    Column("Y", Float),
    Column("xG", Float),
    Column("player", String(80)),
    Column("player_id", BigInteger),
    Column("situation", String(32)),
    Column("season", Integer),
    Column("shot_type", String(32)),
    Column("team_side", String(1)),   # 'h' or 'a'
    Column("home_team", String(80)),
    Column("away_team", String(80)),
    Column("home_goals", Integer),
    Column("away_goals", Integer),
    Column("date_utc", DateTime),
    Column("player_assisted", String(80)),
    Column("last_action", String(32)),
)

match_rosters_data = Table(
    "match_rosters_data", metadata,
    Column("appearance_id", BigInteger, primary_key=True),
    Column("match_id", BigInteger, index=True),
    Column("team_side", String(1)),   # 'h' or 'a'
    Column("player_id", BigInteger, index=True),
    Column("team_id", BigInteger),
    Column("player", String(80)),
    Column("position", String(8)),
    Column("position_order", Integer),
    Column("time_played", Integer),
    Column("goals", Integer),
    Column("own_goals", Integer),
    Column("shots", Integer),
    Column("xG", Float),
    Column("key_passes", Integer),
    Column("assists", Integer),
    Column("xA", Float),
    Column("xGChain", Float),
    Column("xGBuildup", Float),
    Column("yellow_card", Integer),
    Column("red_card", Integer),
    Column("roster_in", BigInteger),
    Column("roster_out", BigInteger),
)

def create_tables(engine: Engine) -> None:
    metadata.create_all(engine)

# -------------------------------------------------------------------
# Helpers: coercion
# -------------------------------------------------------------------
def _to_int(v) -> int | None:
    try:
        if v is None or v == "" or str(v).lower() == "none":
            return None
        return int(float(v))
    except Exception:
        return None

def _to_float(v) -> float | None:
    try:
        if v is None or v == "" or str(v).lower() == "none":
            return None
        return float(v)
    except Exception:
        return None

def _to_dt(v) -> datetime | None:
    try:
        if not v:
            return None
        # API provides "YYYY-MM-DD HH:MM:SS" (UTC)
        return datetime.strptime(v, "%Y-%m-%d %H:%M:%S")
    except Exception:
        return None

# -------------------------------------------------------------------
# Flatteners: transform one API match blob -> rows for each table
# -------------------------------------------------------------------
def _flatten_match_info(mi: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "match_id": _to_int(mi.get("id")),
        "fid": _to_int(mi.get("fid")),
        "home_team_id": _to_int(mi.get("h")),
        "away_team_id": _to_int(mi.get("a")),
        "date_utc": _to_dt(mi.get("date")),
        "league_id": _to_int(mi.get("league_id")),
        "season": _to_int(mi.get("season")),
        "home_goals": _to_int(mi.get("h_goals")),
        "away_goals": _to_int(mi.get("a_goals")),
        "team_h": mi.get("team_h"),
        "team_a": mi.get("team_a"),
        "home_xg": _to_float(mi.get("h_xg")),
        "away_xg": _to_float(mi.get("a_xg")),
        "home_win_prob": _to_float(mi.get("h_w")),
        "home_draw_prob": _to_float(mi.get("h_d")),
        "home_lose_prob": _to_float(mi.get("h_l")),
        "league": mi.get("league"),
        "home_shots": _to_int(mi.get("h_shot")),
        "away_shots": _to_int(mi.get("a_shot")),
        "home_shots_on_target": _to_int(mi.get("h_shotOnTarget")),
        "away_shots_on_target": _to_int(mi.get("a_shotOnTarget")),
        "home_deep": _to_int(mi.get("h_deep")),
        "away_deep": _to_int(mi.get("a_deep")),
        "away_ppda": _to_float(mi.get("a_ppda")),
        "home_ppda": _to_float(mi.get("h_ppda")),
    }

def _flatten_shots(sd: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for side in ("h", "a"):
        for shot in sd.get(side, []):
            rows.append({
                "shot_id": _to_int(shot.get("id")),
                "match_id": _to_int(shot.get("match_id")),
                "minute": _to_int(shot.get("minute")),
                "result": shot.get("result"),
                "X": _to_float(shot.get("X")),
                "Y": _to_float(shot.get("Y")),
                "xG": _to_float(shot.get("xG")),
                "player": shot.get("player"),
                "player_id": _to_int(shot.get("player_id")),
                "situation": shot.get("situation"),
                "season": _to_int(shot.get("season")),
                "shot_type": shot.get("shotType"),
                "team_side": side,
                "home_team": shot.get("h_team"),
                "away_team": shot.get("a_team"),
                "home_goals": _to_int(shot.get("h_goals")),
                "away_goals": _to_int(shot.get("a_goals")),
                "date_utc": _to_dt(shot.get("date")),
                "player_assisted": shot.get("player_assisted"),
                "last_action": shot.get("lastAction"),
            })
    return rows

def _flatten_rosters(rd: Dict[str, Any], match_id: int) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for side in ("h", "a"):
        for _, p in (rd.get(side) or {}).items():
            rows.append({
                "appearance_id": _to_int(p.get("id")),
                "match_id": match_id,
                "team_side": side,
                "player_id": _to_int(p.get("player_id")),
                "team_id": _to_int(p.get("team_id")),
                "player": p.get("player"),
                "position": p.get("position"),
                "position_order": _to_int(p.get("positionOrder")),
                "time_played": _to_int(p.get("time")),
                "goals": _to_int(p.get("goals")),
                "own_goals": _to_int(p.get("own_goals")),
                "shots": _to_int(p.get("shots")),
                "xG": _to_float(p.get("xG")),
                "key_passes": _to_int(p.get("key_passes")),
                "assists": _to_int(p.get("assists")),
                "xA": _to_float(p.get("xA")),
                "xGChain": _to_float(p.get("xGChain")),
                "xGBuildup": _to_float(p.get("xGBuildup")),
                "yellow_card": _to_int(p.get("yellow_card")),
                "red_card": _to_int(p.get("red_card")),
                "roster_in": _to_int(p.get("roster_in")),
                "roster_out": _to_int(p.get("roster_out")),
            })
    return rows

# -------------------------------------------------------------------
# Upsert helpers
# -------------------------------------------------------------------
def _upsert_rows(engine: Engine, table: Table, rows: List[Dict[str, Any]], pk_cols: Tuple[str, ...]) -> int:
    if not rows:
        return 0
    # columns to update = all except PKs
    update_cols = {c.name for c in table.columns} - set(pk_cols)
    stmt = pg_insert(table).values(rows)
    do_update = stmt.on_conflict_do_update(
        index_elements=list(pk_cols),
        set_={c: getattr(stmt.excluded, c) for c in update_cols}
    )
    with engine.begin() as conn:
        result = conn.execute(do_update)
        return result.rowcount or 0

# -------------------------------------------------------------------
# Public API
# -------------------------------------------------------------------
def init_matches_all(api_payload: Dict[str, Any]) -> None:
    """
    Bulk-initialize all matches currently present in the API payload (idempotent).
    api_payload: dict keyed by match URL (or any key) -> { shots_data, match_info, rosters_data }
    """
    engine = get_engine()
    create_tables(engine)

    mi_rows: List[Dict[str, Any]] = []
    shot_rows: List[Dict[str, Any]] = []
    roster_rows: List[Dict[str, Any]] = []

    for _, blob in api_payload.items():
        mi = _flatten_match_info(blob["match_info"])
        mi_rows.append(mi)
        shot_rows.extend(_flatten_shots(blob["shots_data"]))
        roster_rows.extend(_flatten_rosters(blob["rosters_data"], mi["match_id"]))

    _upsert_rows(engine, match_info, mi_rows, ("match_id",))
    _upsert_rows(engine, shots_data, shot_rows, ("shot_id",))
    _upsert_rows(engine, match_rosters_data, roster_rows, ("appearance_id",))

def upsert_match(api_match_blob: Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]] | Dict[str, Any]) -> None:
    """
    Upsert a single match.

    Accepts either:
      - Tuple form (preferred): (shots_data, match_info, rosters_data)
      - Legacy dict form: {"shots_data": ..., "match_info": ..., "rosters_data": ...}
    """
    engine = get_engine()
    create_tables(engine)

    # Unpack payload (tuple preferred; dict supported for compatibility)
    if isinstance(api_match_blob, (tuple, list)):
        if len(api_match_blob) != 3:
            raise ValueError("Expected a 3-tuple: (shots_data, match_info, rosters_data)")
        shots_d, match_i, rosters_d = api_match_blob
    elif isinstance(api_match_blob, dict):
        shots_d = api_match_blob["shots_data"]
        match_i = api_match_blob["match_info"]
        rosters_d = api_match_blob["rosters_data"]
    else:
        raise TypeError("api_match_blob must be a (shots_data, match_info, rosters_data) tuple or a dict with those keys.")

    # Flatten → rows
    mi = _flatten_match_info(match_i)
    shots = _flatten_shots(shots_d)
    rosters = _flatten_rosters(rosters_d, mi["match_id"])

    # Upsert
    _upsert_rows(engine, match_info, [mi], ("match_id",))
    _upsert_rows(engine, shots_data, shots, ("shot_id",))
    _upsert_rows(engine, match_rosters_data, rosters, ("appearance_id",))
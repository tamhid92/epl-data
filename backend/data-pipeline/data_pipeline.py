# epl data pipeline — airflow-friendly refactor
from __future__ import annotations

import os
import sys
import time
import csv
import logging
from functools import wraps
from time import perf_counter
from datetime import datetime, timezone
import pandas as pd
import ScraperFC as sfc
from db_helper import Postgres
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine, Connection

from epl_match import init_matches_all, upsert_match

# ---------------------- Logging (stdout) ----------------------
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
    force=True,
)
logger = logging.getLogger("epl_pipeline")

SQLALCHEMY_ECHO = os.getenv("SQLALCHEMY_ECHO", "false").lower() == "true"

# ---------------------- Config ----------------------
DB_HOST = os.environ.get("DB_HOST")
DB_PORT = os.environ.get("DB_PORT")
DB_NAME = os.environ.get("DB_NAME")
DB_USER = os.environ.get("DB_USER")
DB_PASS = os.environ.get("DB_PASS")

SEASON_ID = os.environ.get("SEASON_ID", "2025/2026")
COMP_ID = os.environ.get("COMP_ID", "EPL")

VENUES_CSV = os.environ.get(
    "VENUES_CSV_PATH",
    os.path.join(os.path.dirname(__file__), "venues.csv")
)
SLEEP_BETWEEN_MATCHES = int(os.environ.get("SLEEP_BETWEEN_MATCHES", "5"))  # seconds

# ---------------------- Helpers ----------------------
def log_step(fn):
    """Decorator to log start/end/duration and capture exceptions."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        logger.info("START %s", fn.__name__)
        t0 = perf_counter()
        try:
            result = fn(*args, **kwargs)
            dt = perf_counter() - t0
            logger.info("DONE  %s in %.2fs", fn.__name__, dt)
            return result
        except Exception as e:
            logger.exception("FAIL  %s: %s", fn.__name__, e)
            raise
    return wrapper

def get_conn_string() -> str:
    return f"postgresql+psycopg2://{DB_USER}:{DB_PASS}@{DB_HOST}:{DB_PORT}/{DB_NAME}"

def get_engine() -> Engine:
    return create_engine(get_conn_string(), future=True, pool_pre_ping=True, echo=SQLALCHEMY_ECHO)

def get_db() -> Postgres:
    return Postgres(get_conn_string())

def get_understat() -> sfc.Understat:
    return sfc.Understat()

def _safe_shape(df: pd.DataFrame | None) -> str:
    try:
        return f"{df.shape[0]}x{df.shape[1]}"
    except Exception:
        return "unknown"

# ---------------------- Venue lookup ----------------------
@log_step
def get_venue(team):
    logger.debug("Looking up venue for team=%s", team)
    try:
        with open("venues.csv", newline="", encoding="utf-8") as file:
            data = list(csv.reader(file))
    except FileNotFoundError:
        logger.warning("venues.csv not found; returning None for team=%s", team)
        return None
    except Exception as e:
        logger.exception("Error reading venues.csv: %s", e)
        return None

    for venue in data:
        if venue and len(venue) >= 2 and venue[0] == team:
            logger.debug("Found venue for %s: %s", team, venue[1])
            return venue[1]
    logger.debug("No venue found for %s", team)
    return None
# ---------------------- Table swap helpers ----------------------
def _swap_and_index(conn: Connection, staging: str, name: str, pk_cols=None, index_sql=()):
    conn.exec_driver_sql(f'DROP TABLE IF EXISTS "{name}" CASCADE')
    conn.exec_driver_sql(f'ALTER TABLE "{staging}" RENAME TO "{name}"')
    if pk_cols:
        cols_csv = ",".join(f'"{c}"' for c in pk_cols)
        conn.exec_driver_sql(f'ALTER TABLE "{name}" ADD PRIMARY KEY ({cols_csv})')
    for sql in index_sql:
        conn.exec_driver_sql(sql)

def replace_table_atomic(df: pd.DataFrame, name: str, bind: Engine | Connection, pk_cols=None, index_sql=()):
    """
    Atomically replace a table:
      1) write DataFrame to staging via to_sql(replace)
      2) in a transaction: DROP real table, RENAME staging to real
      3) reapply PKs and indexes

    `bind` may be an Engine or a Connection.
    """
    staging = f"_{name}_staging"

    # 1) Write staging with the same bind
    df.to_sql(staging, con=bind, if_exists='replace', index=False)

    # 2) Single transaction to swap + 3) reapply PKs/indexes
    if isinstance(bind, Engine):
        with bind.connect() as conn:
            with conn.begin():
                _swap_and_index(conn, staging, name, pk_cols, index_sql)
    elif isinstance(bind, Connection):
        # Begin a txn on the existing connection; execute on the connection (not the transaction)
        with bind.begin():
            _swap_and_index(bind, staging, name, pk_cols, index_sql)
    else:
        raise TypeError("bind must be a SQLAlchemy Engine or Connection")

def _teamname_from_key(k: str) -> str:
    return k.split('/')[-2].replace("_", " ")

def _emit_tables_for_category(all_data: dict, category: str, subcat_col: str):
    created_rows, conceded_rows = [], []
    for key, payload in all_data.items():
        team_name = _teamname_from_key(key)
        cat_dict = payload.get("team_data", {}).get(category, {}) or {}
        for subkey, sval in cat_dict.items():
            created_rows.append({
                "team_name": team_name,
                subcat_col: subkey,
                "shots": sval.get("shots"),
                "goals": sval.get("goals"),
                "xG": sval.get("xG"),
            })
            against = sval.get("against", {}) or {}
            conceded_rows.append({
                "team_name": team_name,
                subcat_col: subkey,
                "shots": against.get("shots"),
                "goals": against.get("goals"),
                "xG": against.get("xG"),
            })
    return pd.DataFrame(created_rows), pd.DataFrame(conceded_rows)

# ───────────────────────────────────────────────────────────────────────────────
# Jobs (self-contained; no module-level state)
# ───────────────────────────────────────────────────────────────────────────────
@log_step
def update_standings():
    engine = get_engine()
    us = get_understat()
    logger.info("Fetching league tables for %s %s", COMP_ID, SEASON_ID)
    standings = us.scrape_league_tables(SEASON_ID, COMP_ID)
    if not standings or len(standings) == 0:
        logger.warning("No standings returned.")
        return
    df = standings[0]
    logger.info("Standings dataframe shape: %s", _safe_shape(df))
    df.to_sql("standings", con=engine, if_exists='replace', index=False)
    logger.info("Standings table replaced in DB.")

@log_step
def update_fixture_list(season_data):
    engine = get_engine()

    fixture_data = season_data[0]
    logger.info("Building fixture list from season data: %d fixtures", len(fixture_data))
    fx_list = []
    for fixture in fixture_data:
        try:
            home_title = fixture['h']['title']
            data = {
                "id": fixture['id'],
                "isResult": fixture['isResult'],
                "home_team_id": fixture['h']['id'],
                "home_team": home_title,
                "home_goals": fixture['goals']['h'],
                "home_xg": fixture['xG']['h'],
                "away_team_id": fixture['a']['id'],
                "away_team": fixture['a']['title'],
                "away_goals": fixture['goals']['a'],
                "away_xg": fixture['xG']['a'],
                "datetime": fixture['datetime'],
                "venue": get_venue(home_title),
            }
            fx_list.append(data)
        except Exception:
            logger.exception("Failed to process fixture row: %s", fixture)
            continue

    fixture_df = pd.DataFrame(fx_list)
    logger.info("Fixture DF built: %s", _safe_shape(fixture_df))
    fixture_df.to_sql("fixtures", con=engine, if_exists='replace', index=False)
    logger.info("Fixtures table replaced in DB.")

@log_step
def build_teams_data(season_data):
    engine = get_engine()
    us = get_understat()

# -------- Source pulls --------
    teams = []
    teams_data = season_data[1]
    all_teams_data = us.scrape_all_teams_data(SEASON_ID, COMP_ID)
    logger.info("Processing teams metadata: %d teams", len(teams_data.keys()))

    for key in teams_data.keys():
        teams.append({
            "team_id": teams_data[key]['id'],
            "team_name": teams_data[key]['title']
        })

    # -------- epl_teams (atomic replace + indexes) --------
    teams_df = pd.DataFrame(teams)
    logger.info("Teams DF shape: %s", _safe_shape(teams_df))
    replace_table_atomic(
        teams_df, "epl_teams", engine,
        pk_cols=["team_id"],
        index_sql=[
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_epl_teams_name ON "epl_teams" ("team_name")'
        ],
    )
    logger.info("epl_teams table replaced in DB.")

    # -------- formations (created & conceded) --------
    formations_created, formations_conceded = [], []
    for key in all_teams_data.keys():
        team_name = _teamname_from_key(key)
        fdict = all_teams_data[key].get('team_data', {}).get('formation', {}) or {}
        for fkey, fval in fdict.items():
            formations_created.append({
                "team_name": team_name,
                "formation": fkey,
                "time": fval.get('time'),
                "shots": fval.get('shots'),
                "goals": fval.get('goals'),
                "xG": fval.get('xG'),
            })
            against = fval.get('against', {}) or {}
            formations_conceded.append({
                "team_name": team_name,
                "formation": fkey,
                "time": fval.get('time'),
                "shots": against.get('shots'),
                "goals": against.get('goals'),
                "xG": against.get('xG'),
            })

    formations_df = pd.DataFrame(formations_created)
    logger.info("Formations DF shape: %s", _safe_shape(formations_df))
    replace_table_atomic(
        formations_df, "formations", engine,
        pk_cols=["team_name", "formation"],
        index_sql=['CREATE INDEX IF NOT EXISTS idx_formations_team ON "formations" ("team_name")']
    )
    logger.info("formations table replaced in DB.")

    formations_conceded_df = pd.DataFrame(formations_conceded)
    logger.info("formations_conceded DF shape: %s", _safe_shape(formations_conceded_df))
    replace_table_atomic(
        formations_conceded_df, "formations_conceded", engine,
        pk_cols=["team_name", "formation"],
        index_sql=['CREATE INDEX IF NOT EXISTS idx_formations_conceded_team ON "formations_conceded" ("team_name")']
    )
    logger.info("formations_conceded table replaced in DB.")

    # -------- situation (created & conceded) --------
    created, conceded = _emit_tables_for_category(all_teams_data, "situation", "situation")
    logger.info("team_chances_created DF shape: %s", _safe_shape(created))
    replace_table_atomic(
        created, "team_chances_created", engine,
        pk_cols=["team_name", "situation"],
        index_sql=['CREATE INDEX IF NOT EXISTS idx_tcc_team ON "team_chances_created" ("team_name")']
    )
    logger.info("team_chances_conceded DF shape: %s", _safe_shape(conceded))
    replace_table_atomic(
        conceded, "team_chances_conceded", engine,
        pk_cols=["team_name", "situation"],
        index_sql=['CREATE INDEX IF NOT EXISTS idx_tconc_team ON "team_chances_conceded" ("team_name")']
    )

    # -------- gameState --------
    created, conceded = _emit_tables_for_category(all_teams_data, "gameState", "state")
    replace_table_atomic(
        created, "game_state", engine,
        pk_cols=["team_name", "state"],
        index_sql=['CREATE INDEX IF NOT EXISTS idx_gs_team ON "game_state" ("team_name")']
    )
    replace_table_atomic(
        conceded, "game_state_conceded", engine,
        pk_cols=["team_name", "state"],
        index_sql=['CREATE INDEX IF NOT EXISTS idx_gsc_team ON "game_state_conceded" ("team_name")']
    )

    # -------- timing --------
    created, conceded = _emit_tables_for_category(all_teams_data, "timing", "period")
    replace_table_atomic(
        created, "timing", engine,
        pk_cols=["team_name", "period"],
        index_sql=['CREATE INDEX IF NOT EXISTS idx_timing_team ON "timing" ("team_name")']
    )
    replace_table_atomic(
        conceded, "timing_conceded", engine,
        pk_cols=["team_name", "period"],
        index_sql=['CREATE INDEX IF NOT EXISTS idx_timingc_team ON "timing_conceded" ("team_name")']
    )

    # -------- shotZone --------
    created, conceded = _emit_tables_for_category(all_teams_data, "shotZone", "zone")
    replace_table_atomic(
        created, "shot_zone", engine,
        pk_cols=["team_name", "zone"],
        index_sql=['CREATE INDEX IF NOT EXISTS idx_sz_team ON "shot_zone" ("team_name")']
    )
    replace_table_atomic(
        conceded, "shot_zone_conceded", engine,
        pk_cols=["team_name", "zone"],
        index_sql=['CREATE INDEX IF NOT EXISTS idx_szc_team ON "shot_zone_conceded" ("team_name")']
    )

    # -------- attackSpeed --------
    created, conceded = _emit_tables_for_category(all_teams_data, "attackSpeed", "speed")
    replace_table_atomic(
        created, "attack_speed", engine,
        pk_cols=["team_name", "speed"],
        index_sql=['CREATE INDEX IF NOT EXISTS idx_as_team ON "attack_speed" ("team_name")']
    )
    replace_table_atomic(
        conceded, "attack_speed_conceded", engine,
        pk_cols=["team_name", "speed"],
        index_sql=['CREATE INDEX IF NOT EXISTS idx_asc_team ON "attack_speed_conceded" ("team_name")']
    )

    # -------- result --------
    created, conceded = _emit_tables_for_category(all_teams_data, "result", "result_type")
    replace_table_atomic(
        created, "result", engine,
        pk_cols=["team_name", "result_type"],
        index_sql=['CREATE INDEX IF NOT EXISTS idx_res_team ON "result" ("team_name")']
    )
    replace_table_atomic(
        conceded, "result_conceded", engine,
        pk_cols=["team_name", "result_type"],
        index_sql=['CREATE INDEX IF NOT EXISTS idx_resc_team ON "result_conceded" ("team_name")']
    )

    logger.info("All tables replaced atomically.")

@log_step
def update_player_db(season_data):
    engine = get_engine()
    players_df = pd.DataFrame(season_data[2])
    logger.info("Players DF shape: %s", _safe_shape(players_df))
    players_df.to_sql("players", con=engine, if_exists='replace', index=False)
    logger.info("players table replaced in DB.")

@log_step
def init_match_data():
    us = get_understat()
    logger.info("Scraping initial matches for %s %s", COMP_ID, SEASON_ID)
    all_match_data = us.scrape_matches(SEASON_ID, COMP_ID)
    logger.info("Matches scraped: %d", len(all_match_data))
    init_matches_all(all_match_data)
    logger.info("Initial match data inserted/upserted.")

@log_step
def update_match_data():
    db = get_db()
    us = get_understat()

    MATCH_BASE_URL = "https://understat.com/match/"
    SQL_QUERY = 'SELECT * FROM fixtures WHERE "isResult" IS False'
    logger.info("Querying upcoming/unresolved fixtures: %s", SQL_QUERY)
    result = db.query_all(SQL_QUERY)
    logger.info("Fixtures pending result: %d", len(result))

    format_string = "%Y-%m-%d %H:%M:%S"
    today = datetime.now(timezone.utc).strftime(format_string)
    today_obj = datetime.strptime(today, format_string)

    match_ids = []
    for r in result:
        try:
            date_object = datetime.strptime(r["datetime"], format_string)
            if date_object <= today_obj:
                match_ids.append(r['id'])
        except Exception:
            logger.exception("Bad datetime row (skipping): %s", r)

    logger.info("Fixtures due for update (<= now UTC): %d; sample=%s",
                len(match_ids), match_ids[:10])

    for mid in match_ids:
        match_url = f"{MATCH_BASE_URL}{mid}"
        logger.info("Scraping match %s -> %s", mid, match_url)
        try:
            match_data = us.scrape_match(match_url)
            upsert_match(match_data)
            logger.info("Upserted match_id=%s", mid)
        except Exception:
            logger.exception("Failed to upsert match_id=%s", mid)
        logger.debug("Sleeping 5s to be polite to the source…")
        time.sleep(5)

@log_step
def init_db():
    us = get_understat()
    logger.info("Scraping season data for %s %s", COMP_ID, SEASON_ID)
    season_data = us.scrape_season_data(SEASON_ID, COMP_ID)
    logger.info("Season data scraped: fixtures=%s, teams/meta=%s, players=%s",
                len(season_data[0]) if season_data and len(season_data) > 0 else "?", 
                len(season_data[1]) if season_data and len(season_data) > 1 else "?", 
                len(season_data[2]) if season_data and len(season_data) > 2 else "?")
    time.sleep(5)
    update_standings()
    update_player_db(season_data)
    update_fixture_list(season_data)
    build_teams_data(season_data)
    logger.debug("Pause before match init…")
    time.sleep(5)
    init_match_data()

@log_step
def update_db():
    us = get_understat()
    logger.info("Scraping season data for %s %s", COMP_ID, SEASON_ID)
    season_data = us.scrape_season_data(SEASON_ID, COMP_ID)
    logger.info("Season data scraped: fixtures=%s, teams/meta=%s, players=%s",
                len(season_data[0]) if season_data and len(season_data) > 0 else "?", 
                len(season_data[1]) if season_data and len(season_data) > 1 else "?", 
                len(season_data[2]) if season_data and len(season_data) > 2 else "?")
    time.sleep(5)
    update_match_data()
    logger.debug("Post-match update pause…")
    time.sleep(5)
    update_standings()
    update_player_db(season_data)
    update_fixture_list(season_data)
    build_teams_data(season_data)

def _main():
    logger.info("Pipeline start: COMP_ID=%s SEASON_ID=%s", COMP_ID, SEASON_ID)
    t0 = perf_counter()
    mode = (sys.argv[1] if len(sys.argv) > 1 else os.getenv("PIPELINE_MODE", "update")).lower()
    try:
        if mode == "init":
            init_db()
        elif mode == "update":
            update_db()
        else:
            raise SystemExit(f"Unknown mode: {mode} (expected 'init' or 'update')")
    finally:
        dt = perf_counter() - t0
        logger.info("Pipeline complete in %.2fs", dt)

# ---------------------- Entrypoint ----------------------
if __name__ == "__main__":
    _main()

#!/usr/bin/env python3
from __future__ import annotations
import os, requests
import pandas as pd
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, List, Optional

POS_MAP = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}

BOOTSTRAP_URL = "https://fantasy.premierleague.com/api/bootstrap-static/"
EVENT_LIVE_URL_TPL = "https://fantasy.premierleague.com/api/event/{gw}/live/"
FIXTURES_URL = "https://fantasy.premierleague.com/api/fixtures/"

# Unified dirs
DATA_DIR = os.environ.get("DATA_DIR", "/data").rstrip("/")
TMP_DIR = os.environ.get("TMP_DIR", "/tmp").rstrip("/")

def _ensure_dir(p: str) -> None:
    os.makedirs(p, exist_ok=True)

# ---------------- Fetchers ----------------
def fetch_bootstrap() -> Dict[str, Any]:
    r = requests.get(BOOTSTRAP_URL, timeout=30)
    r.raise_for_status()
    return r.json()

def fetch_event_live(gw: int) -> Dict[str, Any]:
    r = requests.get(EVENT_LIVE_URL_TPL.format(gw=gw), timeout=30)
    r.raise_for_status()
    return r.json()

def fetch_fixtures() -> List[Dict[str, Any]]:
    r = requests.get(FIXTURES_URL, timeout=30)
    r.raise_for_status()
    return r.json()

# ---------------- Lookups ----------------
def build_player_lookup(bootstrap: Dict[str, Any]) -> Dict[int, Dict[str, Any]]:
    teams = {t["id"]: t["name"] for t in bootstrap.get("teams", [])}
    lookup: Dict[int, Dict[str, Any]] = {}
    for e in bootstrap.get("elements", []):
        el_id = e["id"]
        name = f'{e.get("first_name","") or ""} {e.get("second_name","") or ""}'.strip()
        lookup[el_id] = {
            "name": name,
            "position": POS_MAP.get(e.get("element_type")),
            "team_id": e.get("team"),
            "team_name": teams.get(e.get("team")),
            "now_cost": e.get("now_cost"),
            "transfers_in_event": e.get("transfers_in_event"),
            "transfers_out_event": e.get("transfers_out_event"),
        }
    return lookup

def build_teams_map(bootstrap: Dict[str, Any]) -> Dict[int, Dict[str, Any]]:
    return {t["id"]: t for t in bootstrap.get("teams", [])}

def build_fixture_lookup(fixtures: List[Dict[str, Any]], gw: int) -> Dict[int, Dict[str, Any]]:
    out = {}
    for f in fixtures:
        if f.get("event") == gw:
            out[f["id"]] = {
                "event": f.get("event"),
                "kickoff_time": f.get("kickoff_time"),
                "team_h": f.get("team_h"),
                "team_a": f.get("team_a"),
                "team_h_score": f.get("team_h_score"),
                "team_a_score": f.get("team_a_score"),
            }
    return out

def fixtures_for_team_in_window(fixtures: List[Dict[str, Any]], team_id: int,
                                start_dt: datetime, end_dt: datetime) -> List[Dict[str, Any]]:
    out = []
    for f in fixtures:
        ko = f.get("kickoff_time")
        if not ko:
            continue
        try:
            ko_dt = datetime.fromisoformat(ko.replace("Z", "+00:00"))
        except Exception:
            continue
        if start_dt <= ko_dt <= end_dt and (f.get("team_h") == team_id or f.get("team_a") == team_id):
            out.append(f)
    return out

# ---------------- Utilities ----------------
def defensive_contribution(stats: Dict[str, Any]) -> Optional[float]:
    if stats.get("defensive_contribution") is not None:
        return stats["defensive_contribution"]
    parts = [stats.get("clearances_blocks_interceptions"),
             stats.get("recoveries"),
             stats.get("tackles")]
    parts = [p for p in parts if p is not None]
    return float(sum(parts)) if parts else None

def _event_live_index_by_element(event_live: Dict[str, Any]) -> Dict[int, Dict[str, Any]]:
    return {el.get("id"): el for el in event_live.get("elements", [])}

def _points_in_explain_block(ex_block: Dict[str, Any]) -> int:
    pts = 0
    for s in ex_block.get("stats", []):
        pts += int(s.get("points", 0) or 0)
    return pts

def compute_player_form(el_id: int, team_id: int, fixtures: List[Dict[str, Any]],
                        event_live_cache: Dict[int, Dict[str, Any]],
                        now_utc: Optional[datetime] = None) -> float:
    if now_utc is None:
        now_utc = datetime.now(timezone.utc)
    start_dt = now_utc - timedelta(days=30)
    team_fx = fixtures_for_team_in_window(fixtures, team_id, start_dt, now_utc)
    if not team_fx:
        return 0.0
    by_fx: Dict[int, int] = {}
    events_needed: set[int] = set()
    for f in team_fx:
        fx_id = f.get("id")
        ev = f.get("event")
        if fx_id is not None and ev is not None:
            by_fx[fx_id] = ev
            events_needed.add(ev)
    for ev in events_needed:
        if ev not in event_live_cache:
            event_live_cache[ev] = fetch_event_live(ev)
    total_pts = 0
    matches_played = 0
    for fx_id, ev in by_fx.items():
        el_map = _event_live_index_by_element(event_live_cache[ev])
        el_entry = el_map.get(el_id)
        if not el_entry:
            continue
        explains = el_entry.get("explain", []) or []
        for ex in explains:
            if ex.get("fixture") == fx_id:
                total_pts += _points_in_explain_block(ex)
                matches_played += 1
                break
    return (float(total_pts) / float(matches_played)) if matches_played else 0.0

# ---------------- Row composition ----------------
def compose_row(
    *,
    name: Optional[str],
    position: Optional[str],
    team: Optional[str],
    el_id: int,
    stats: Dict[str, Any],
    fx: Optional[Dict[str, Any]],
    team_id: Optional[int],
    gw: int,
    season: int,
    value: Optional[int],
    transfers_in: Optional[int],
    transfers_out: Optional[int],
    transfers_balance: Optional[int],
    teams_map: Dict[int, Dict[str, Any]],
    form_val: Optional[float],
    fixture_id: Optional[int] = None
) -> Dict[str, Any]:
    if fx and team_id:
        team_h, team_a = fx.get("team_h"), fx.get("team_a")
        was_home = True if team_id == team_h else (False if team_id == team_a else None)
        opponent_team = (team_a if was_home else team_h) if was_home is not None else None
        kickoff_time = fx.get("kickoff_time")
        team_h_score = fx.get("team_h_score")
        team_a_score = fx.get("team_a_score")
    else:
        was_home = None
        opponent_team = None
        kickoff_time = None
        team_h_score = None
        team_a_score = None

    xP = stats.get("xP", stats.get("expected_points"))
    starts = stats.get("starts")
    if starts is None:
        starts = 1 if (stats.get("minutes") or 0) > 0 else 0

    strength_overall_home = teams_map.get(team_id, {}).get("strength_overall_home") if team_id else None
    strength_overall_away = teams_map.get(team_id, {}).get("strength_overall_away") if team_id else None
    opponent_team_difficulty = teams_map.get(opponent_team, {}).get("strength")

    return {
        "name": name, "position": position, "team": team, "xP": xP,
        "assists": stats.get("assists"), "bonus": stats.get("bonus"), "bps": stats.get("bps"),
        "clean_sheets": stats.get("clean_sheets"),
        "clearances_blocks_interceptions": stats.get("clearances_blocks_interceptions"),
        "creativity": stats.get("creativity"),
        "defensive_contribution": defensive_contribution(stats),
        "element": el_id, "expected_assists": stats.get("expected_assists"),
        "expected_goal_involvements": stats.get("expected_goal_involvements"),
        "expected_goals": stats.get("expected_goals"),
        "expected_goals_conceded": stats.get("expected_goals_conceded"),
        "fixture": fixture_id, "goals_conceded": stats.get("goals_conceded"),
        "goals_scored": stats.get("goals_scored"), "ict_index": stats.get("ict_index"),
        "influence": stats.get("influence"), "kickoff_time": kickoff_time,
        "minutes": stats.get("minutes"), "opponent_team": opponent_team,
        "own_goals": stats.get("own_goals"), "penalties_missed": stats.get("penalties_missed"),
        "penalties_saved": stats.get("penalties_saved"), "recoveries": stats.get("recoveries"),
        "red_cards": stats.get("red_cards"), "round": gw, "saves": stats.get("saves"),
        "selected": stats.get("selected"), "starts": starts, "tackles": stats.get("tackles"),
        "team_a_score": team_a_score, "team_h_score": team_h_score, "threat": stats.get("threat"),
        "total_points": stats.get("total_points"), "transfers_balance": transfers_balance,
        "transfers_in": transfers_in, "transfers_out": transfers_out, "value": value,
        "was_home": was_home, "yellow_cards": stats.get("yellow_cards"),
        "season": season, "gameweek": gw, "opponent_team_difficulty": opponent_team_difficulty,
        "strength_overall_home": strength_overall_home, "strength_overall_away": strength_overall_away,
        "form": form_val
    }

# ---------------- Builders ----------------
def build_gameweek_rows(gw: int, season: Optional[int] = None) -> pd.DataFrame:
    if season is None:
        season = datetime.utcnow().year
    bootstrap = fetch_bootstrap()
    live = fetch_event_live(gw)
    fixtures = fetch_fixtures()

    players = build_player_lookup(bootstrap)
    teams_map = build_teams_map(bootstrap)
    fixtures_by_id = build_fixture_lookup(fixtures, gw)

    event_live_cache: Dict[int, Dict[str, Any]] = {gw: live}
    rows: List[Dict[str, Any]] = []

    for el in live.get("elements", []):
        el_id = el.get("id")
        stats = el.get("stats", {}) or {}
        explains = el.get("explain", []) or []

        pinfo = players.get(el_id, {})
        name = pinfo.get("name"); position = pinfo.get("position")
        team_id = pinfo.get("team_id"); team = pinfo.get("team_name")
        value = pinfo.get("now_cost")
        tin = pinfo.get("transfers_in_event"); tout = pinfo.get("transfers_out_event")
        tbal = (tin or 0) - (tout or 0) if (tin is not None and tout is not None) else None

        try:
            form_val = compute_player_form(el_id, team_id, fixtures, event_live_cache)
        except Exception:
            form_val = None

        if not explains:
            rows.append(compose_row(
                name=name, position=position, team=team, el_id=el_id,
                stats=stats, fx=None, team_id=team_id, gw=gw, season=season,
                value=value, transfers_in=tin, transfers_out=tout, transfers_balance=tbal,
                teams_map=teams_map, form_val=form_val
            ))
            continue

        for ex in explains:
            fx_id = ex.get("fixture")
            fx = fixtures_by_id.get(fx_id)
            rows.append(compose_row(
                name=name, position=position, team=team, el_id=el_id,
                stats=stats, fx=fx, team_id=team_id, gw=gw, season=season,
                value=value, transfers_in=tin, transfers_out=tout, transfers_balance=tbal,
                fixture_id=fx_id, teams_map=teams_map, form_val=form_val
            ))

    df = pd.DataFrame(rows)
    cols = [
        "name","position","team","xP","assists","bonus","bps","clean_sheets","clearances_blocks_interceptions",
        "creativity","defensive_contribution","element","expected_assists","expected_goal_involvements","expected_goals","expected_goals_conceded",
        "fixture","goals_conceded","goals_scored","ict_index","influence","kickoff_time","minutes","opponent_team","own_goals","penalties_missed",
        "penalties_saved","recoveries","red_cards","round","saves","selected","starts","tackles","team_a_score","team_h_score","threat","total_points",
        "transfers_balance","transfers_in","transfers_out","value","was_home","yellow_cards","season","gameweek","opponent_team_difficulty",
        "strength_overall_home","strength_overall_away","form"
    ]
    for c in cols:
        if c not in df.columns:
            df[c] = None
    return df[cols]

# ---------------- Merge helpers ----------------
def _current_path() -> str:
    _ensure_dir(DATA_DIR)
    return os.path.join(DATA_DIR, "current_data.csv")

def _gw_path(gw: int) -> str:
    _ensure_dir(DATA_DIR)
    return os.path.join(DATA_DIR, f"gw{gw}.csv")

def check_and_drop_gw(gw: int) -> None:
    """Remove any existing rows of this GW from current_data.csv if file exists."""
    cur_path = _current_path()
    if not os.path.exists(cur_path):
        return
    df = pd.read_csv(cur_path)
    if df.empty or "gameweek" not in df.columns:
        return
    if not df[df["gameweek"] == int(gw)].empty:
        # Keep all other rows and atomically replace
        new_df = df[df["gameweek"] != int(gw)]
        tmp_path = cur_path + ".tmp"
        new_df.to_csv(tmp_path, index=False)
        os.replace(tmp_path, cur_path)

def merge_gw_into_current(gw: int) -> None:
    cur_path = _current_path()
    gw_path = _gw_path(gw)

    to_concat = []
    if os.path.exists(cur_path):
        cur = pd.read_csv(cur_path)
        cur = cur.dropna(axis=1, how="all")
        to_concat.append(cur)

    df = pd.read_csv(gw_path).dropna(axis=1, how="all")
    to_concat.append(df)

    merged_df = pd.concat(to_concat, ignore_index=True)
    tmp_path = cur_path + ".tmp"
    merged_df.to_csv(tmp_path, index=False)
    os.replace(tmp_path, cur_path)

def append_gw_to_current(gw: int, season: int = 2025) -> None:
    # Ensure old rows for this GW are removed before append
    check_and_drop_gw(gw)
    # Build and save the temporary GW CSV in the persistent directory
    df = build_gameweek_rows(gw=gw, season=season)
    gw_file = _gw_path(gw)
    df.to_csv(gw_file, index=False)
    print(f"[append] wrote {gw_file}")

    # Merge → current_data.csv
    merge_gw_into_current(gw)
    print(f"[append] merged gw{gw} into current_data.csv")

    # Cleanup temp file
    try:
        os.remove(gw_file)
        print(f"[append] removed temp {gw_file}")
    except FileNotFoundError:
        pass

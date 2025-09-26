#!/usr/bin/env python3
# -*- coding: utf-8 -*-

#Import FPL Bootstrap FPL data to Postgres

from __future__ import annotations
import argparse
import sys
import re
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Tuple
import os
import pandas as pd
import requests
from difflib import SequenceMatcher

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

# ---------- Config (edit if needed) ----------
API_TOKEN = os.environ.get("API_TOKEN")
PLAYERS_URL = "http://epl-api.epl-data.svc.cluster.local:8000/fbref/players"
TEAMS_URL = "http://epl-api.epl-data.svc.cluster.local:8000/teams"
FPL_BOOTSTRAP = "https://fantasy.premierleague.com/api/bootstrap-static/"

HEADERS =  {
      'X-API-Token': API_TOKEN,
    }

TABLE_NAME = "fpl_elements_enriched"

# ---------- Optional libs ----------
try:
    from rapidfuzz import fuzz
except Exception:
    fuzz = None

try:
    import jellyfish
except Exception:
    jellyfish = None

try:
    from unidecode import unidecode
except Exception:
    unidecode = None

# ---------- Normalization helpers ----------
_WS_RE = re.compile(r"\s+")
_PUNCT_RE = re.compile(r"[^\w\s-]")  # keep hyphens

def _strip_accents(s: str) -> str:
    if not isinstance(s, str):
        s = "" if s is None else str(s)
    if unidecode is not None:
        return unidecode(s)
    nfkd = unicodedata.normalize("NFKD", s)
    return "".join(ch for ch in nfkd if not unicodedata.combining(ch))

def norm(s: Any) -> str:
    s = "" if s is None else str(s)
    s = _strip_accents(s).lower()
    s = _PUNCT_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s).strip()
    return s

def tokens(s: str) -> List[str]:
    return [t for t in norm(s).split() if t]

def first_last(s: str) -> Tuple[str, str]:
    ts = tokens(s)
    if not ts:
        return "", ""
    if len(ts) == 1:
        return ts[0], ts[0]
    return ts[0], ts[-1]

CONNECTORS = {"da","de","del","della","der","di","la","le","van","von","dos","das","do","du","mc","mac"}

def prune_connectors(ts: List[str]) -> List[str]:
    return [t for t in ts if t not in CONNECTORS]

def hyphen_splits(name: str) -> List[str]:
    n = norm(name)
    if "-" not in n:
        return [n]
    parts = [p for p in n.split("-") if p]
    out = [" ".join(parts)]
    out.extend(parts)
    return sorted(set(out))

NICKNAMES = {
    "alex":"alexander","sasha":"alexander",
    "will":"william","bill":"william","billy":"william","liam":"william",
    "ben":"benjamin","jamie":"james","jim":"james",
    "joe":"joseph","josh":"joshua","matty":"matthew","matt":"matthew",
    "toni":"antonio","tony":"anthony",
    "harry":"harold",
    "nick":"nicholas","nico":"nicholas",
    "luiz":"luis","lucho":"luis",
}

def expand_given(name: str) -> List[str]:
    f, l = first_last(name)
    out = [name]
    alt = NICKNAMES.get(f)
    if alt:
        out.append(f"{alt} {l}".strip())
    return out

def name_variants(name: str) -> List[str]:
    base = norm(name)
    if not base:
        return []
    ts = tokens(name)
    ts_nc = prune_connectors(ts)
    f, l = (ts_nc[0], ts_nc[-1]) if ts_nc else first_last(name)

    variants: set[str] = set()
    variants.add(" ".join(ts_nc) if ts_nc else base)
    if f or l:
        variants.add(f"{f} {l}".strip())
        variants.add(f"{f[:1]} {l}".strip() if f else l)
        variants.add(l)
        variants.add(f"{l} {f}".strip())
    for piece in hyphen_splits(" ".join(ts_nc) if ts_nc else base):
        variants.add(piece)
    for alt in expand_given(f"{f} {l}".strip()):
        variants.add(norm(alt))
    return sorted(v for v in variants if v)

def surname_phonetic(surname: str) -> str:
    if not surname:
        return ""
    if jellyfish is not None:
        try:
            mp = jellyfish.metaphone(surname)
            if mp:
                return mp
            sx = jellyfish.soundex(surname)
            return sx or ""
        except Exception:
            return ""
    return ""

def jaro_winkler(a: str, b: str) -> float:
    if jellyfish is not None:
        try:
            return float(jellyfish.jaro_winkler_similarity(a, b))
        except Exception:
            pass
    return float(SequenceMatcher(None, a, b).ratio())

# ---------- Team canonicalization ----------
SHORT_TO_NAME = {
    "ARS": "Arsenal", "AVL": "Aston Villa", "BOU": "Bournemouth", "BRE": "Brentford",
    "BHA": "Brighton", "BUR": "Burnley", "CHE": "Chelsea", "CRY": "Crystal Palace",
    "EVE": "Everton", "FUL": "Fulham", "LEE": "Leeds", "LIV": "Liverpool",
    "MCI": "Manchester City", "MUN": "Manchester United", "NEW": "Newcastle United",
    "NFO": "Nottingham Forest", "TOT": "Tottenham", "WHU": "West Ham",
    "WOL": "Wolverhampton Wanderers", "LEI": "Leicester City", "SOU":"Southampton",
    "NOR":"Norwich City","WAT":"Watford","SHE":"Sheffield United",
    "IPS":"Ipswich Town","SUN":"Sunderland",
}
TEAM_ALIASES = {
    "spurs": "Tottenham",
    "wolves": "Wolverhampton Wanderers",
    "man city": "Manchester City",
    "man utd": "Manchester United",
    "manchester utd": "Manchester United",
    "brighton & hove albion": "Brighton",
    "forest": "Nottingham Forest",
    "west ham united": "West Ham",
    "leeds united": "Leeds",
}

def normalize_team(raw: str, team_normset: set[str]) -> str:
    if raw is None:
        return ""
    s = str(raw).strip()
    code = s.upper()
    if code in SHORT_TO_NAME:
        return SHORT_TO_NAME[code]
    alias = TEAM_ALIASES.get(norm(s))
    if alias:
        return alias
    if norm(s) in team_normset:
        return s
    return s

# ---------- Catalog fetch/flatten ----------
def fetch_teams(teams_url: str) -> pd.DataFrame:
    try:
        data = requests.get(teams_url, headers=HEADERS, timeout=30).json()
        print(f"Retrieved data from teams API - {teams_url}")
        rows = []
        for t in data if isinstance(data, list) else []:
            name = t.get("team_name", "")
            rows.append({
                "team_id": t.get("team_id",""),
                "team_name": name,
                "norm_team": norm(name)
            })
        return pd.DataFrame(rows)
    except:
        raise RuntimeError(f"API not reachable -- url = {teams_url}")

def fetch_players(players_url: str) -> List[Dict[str, Any]]:
    try:
        data = requests.get(players_url, headers=HEADERS, timeout=60).json()
        if isinstance(data, list) and data and isinstance(data[0], dict) and "get_all_players_stats" in data[0]:
            return data[0]["get_all_players_stats"]
        if isinstance(data, list):
            return data
        for v in (data.values() if isinstance(data, dict) else []):
            if isinstance(v, list) and v and isinstance(v[0], dict) and ("fbref" in v[0] or "player_name" in v[0]):
                return v
        raise RuntimeError("Unrecognized players payload shape; expected data[0]['get_all_players_stats'].")
    except:
        raise RuntimeError(f"API not reachable -- url = {players_url}")

def flatten_players(players: List[Dict[str, Any]]) -> pd.DataFrame:
    rows = []
    for item in players:
        pname = item.get("player_name","") or ""
        ids = item.get("ids",{}) or {}
        fbref_id = ids.get("fbref","") or ""
        understat_id = ids.get("understat","") or ""
        understat_team = item.get("understat_team","") or ""

        fbref_team = ""
        fbref_block = item.get("fbref",{})
        if isinstance(fbref_block, dict):
            preferred = ("standard","defensive","goal_and_shot_creation","possession","passing","pass_types","shooting")
            for key in preferred:
                sub = fbref_block.get(key)
                if isinstance(sub, dict) and "team_name" in sub:
                    fbref_team = sub.get("team_name") or fbref_team
                    break
            if not fbref_team:
                for sub in fbref_block.values():
                    if isinstance(sub, dict) and "team_name" in sub:
                        fbref_team = sub.get("team_name") or fbref_team

        cat_team = fbref_team or understat_team
        _, l = first_last(pname)
        rows.append({
            "player_name": pname,
            "catalog_team_name": cat_team,
            "fbref_id": fbref_id,
            "understat_id": understat_id,
            "norm_player": norm(pname),
            "tok_player": " ".join(tokens(pname)),
            "norm_team": norm(cat_team),
            "surname": l,
            "surname_phon": surname_phonetic(l),
            "variants": name_variants(pname),
        })
    df = pd.DataFrame(rows).drop_duplicates(subset=["player_name","fbref_id","understat_id"], keep="first")
    return df

# ---------- Similarity scoring ----------
def score_pair(a: str, b: str) -> float:
    a_n = norm(a); b_n = norm(b)
    if not a_n or not b_n:
        return 0.0

    jw = jaro_winkler(a_n, b_n)  # 0..1
    if fuzz is not None:
        try:
            w = fuzz.WRatio(a_n, b_n) / 100.0
            ts = fuzz.token_set_ratio(a_n, b_n) / 100.0
            tr = fuzz.token_sort_ratio(a_n, b_n) / 100.0
        except Exception:
            w = ts = tr = 0.0
    else:
        w = ts = tr = SequenceMatcher(None, a_n, b_n).ratio()

    base = 0.35*ts + 0.25*w + 0.20*tr + 0.20*jw
    return float(max(0.0, min(1.0, base)))

def score_player(pred_name: str, cand_row: pd.Series) -> Tuple[float, str]:
    f_pred, l_pred = first_last(pred_name)
    l_cand = cand_row.get("surname","")
    ph_pred = surname_phonetic(l_pred)
    ph_cand = cand_row.get("surname_phon","")

    best = 0.0
    best_var = ""
    for v in cand_row.get("variants", []) or [cand_row.get("player_name","")]:
        s = score_pair(pred_name, v)

        bonus = 0.0
        if l_pred and l_cand and l_pred == l_cand:
            bonus += 0.05
        if f_pred and cand_row.get("player_name",""):
            cf, _ = first_last(cand_row["player_name"])
            if cf and f_pred[:1] == cf[:1]:
                bonus += 0.03
        if ph_pred and ph_cand and ph_pred == ph_cand:
            bonus += 0.03

        s_final = min(1.0, s + bonus)
        if s_final > best:
            best = s_final
            best_var = v

    dbg = f"base_best_on='{best_var}', score={best:.3f}"
    return best, dbg

def match_player_row(
    pred_name: str,
    team_name: str,
    catalog: pd.DataFrame,
    team_threshold: float = 0.84,
    global_threshold: float = 0.88
) -> Tuple[str, str, str, str, str, float, str]:
    """
    Returns: (fbref_id, understat_id, matched_player_name, matched_team, method, confidence, debug)
    """
    tnorm = norm(team_name)

    def pick_best(df: pd.DataFrame) -> Tuple[pd.Series|None, float, str]:
        best_row = None
        best_score = 0.0
        best_dbg = ""
        for _, r in df.iterrows():
            s, dbg = score_player(pred_name, r)
            if s > best_score:
                best_score, best_row, best_dbg = s, r, dbg
        return best_row, best_score, best_dbg

    sub = catalog[catalog["norm_team"] == tnorm] if tnorm else pd.DataFrame(columns=catalog.columns)
    if not sub.empty:
        r, score, dbg = pick_best(sub)
        if r is not None and score >= team_threshold:
            return (r["fbref_id"] or "", r["understat_id"] or "",
                    r["player_name"], r["catalog_team_name"], "team_block", float(score), dbg)

    r, score, dbg = pick_best(catalog)
    if r is not None and score >= global_threshold:
        return (r["fbref_id"] or "", r["understat_id"] or "",
                r["player_name"], r["catalog_team_name"], "global", float(score), dbg)

    return "", "", "", "", "none", 0.0, "no match above thresholds"


def get_engine(conn) -> Engine:
    return create_engine(conn, future=True, pool_pre_ping=True)

# ---------- Main pipeline ----------
def main(conn):
    ap = argparse.ArgumentParser()
    ap.add_argument("--players-url", default=PLAYERS_URL)
    ap.add_argument("--teams-url", default=TEAMS_URL)
    ap.add_argument("--fpl-url", default=FPL_BOOTSTRAP)
    ap.add_argument("--table", default=TABLE_NAME)
    ap.add_argument("--team-threshold", type=float, default=0.84)
    ap.add_argument("--global-threshold", type=float, default=0.88)
    args = ap.parse_args()

    # 1) Fetch canonical teams & build norm set + id map
    teams_df = fetch_teams(args.teams_url)
    if teams_df.empty:
        raise RuntimeError("No teams returned from teams endpoint.")
    team_normset = set(teams_df["norm_team"].tolist())
    tmap_norm_to_id = {r["norm_team"]: r["team_id"] for _, r in teams_df.iterrows()}

    # 2) Fetch FPL bootstrap-static (players + teams)
    bs = requests.get(args.fpl_url, timeout=60).json()
    fpl_elements = bs.get("elements", [])
    fpl_teams = bs.get("teams", [])  # id, name, short_name, code, etc.

    fpl_team_by_id = {t["id"]: t for t in fpl_teams}
    fpl_team_by_code = {t.get("code"): t for t in fpl_teams}

    events = bs.get("events")
    for i in events:
        if i['finished']:
            pass
        else:
            gameweek = i['id']
            break

    # 3) Build a DataFrame from elements
    def full_name(el: dict) -> str:
        # Prefer first + second; fallback to web_name
        fn = (el.get("first_name") or "").strip()
        sn = (el.get("second_name") or "").strip()
        if fn or sn:
            return f"{fn} {sn}".strip()
        return el.get("web_name") or ""

    rows = []
    for el in fpl_elements:
        team_id_fpl = el.get("team")
        team_code = el.get("team_code")
        fpl_team = fpl_team_by_id.get(team_id_fpl, {})
        fpl_team_name = fpl_team.get("name") or ""

        rows.append({
            **el,
            "player_name_raw": full_name(el),
            "fpl_team_name_raw": fpl_team_name,
        })

    df = pd.DataFrame(rows)

    # 4) Normalize team names & attach your internal team_id
    df["canonical_team_name"] = df["fpl_team_name_raw"].apply(lambda x: normalize_team(x, team_normset))
    df["team_norm"] = df["canonical_team_name"].apply(norm)
    df["team_id_internal"] = df["team_norm"].map(tmap_norm_to_id).fillna("")

    # 5) Fetch and flatten your player catalog (FBref/Understat)
    players_list = fetch_players(args.players_url)
    catalog = flatten_players(players_list)

    # 6) Match each FPL player to catalog
    fb_ids, us_ids, match_names, match_teams, methods, confs, dbgs = [], [], [], [], [], [], []
    unmatched = []

    for _, r in df.iterrows():
        pname = r.get("player_name_raw","")
        tname = r.get("canonical_team_name","") or r.get("fpl_team_name_raw","")
        fb, us, mp, mt, method, conf, dbg = match_player_row(
            pname, tname, catalog,
            team_threshold=args.team_threshold,
            global_threshold=args.global_threshold
        )
        fb_ids.append(fb)
        us_ids.append(us)
        match_names.append(mp)
        match_teams.append(mt)
        methods.append(method)
        confs.append(conf)
        dbgs.append(dbg)

        if not fb and not us:
            unmatched.append({
                "player_name_raw": pname,
                "fpl_team_name_raw": r.get("fpl_team_name_raw",""),
                "canonical_team_name": tname,
                "norm_player": norm(pname),
                "norm_team": norm(tname),
                "debug": dbg
            })

    df["fbref_id"] = fb_ids
    df["understat_id"] = us_ids
    df["matched_player_name"] = match_names
    df["matched_team_from_catalog"] = match_teams
    df["match_method"] = methods
    df["match_confidence"] = confs
    df["match_debug"] = dbgs

    # 7) Add normalized player_name column (aligned to catalog when available)
    #    If matched, use catalog's normalized; else normalized raw.
    def normalized_player_name(row) -> str:
        if row.get("matched_player_name"):
            return " ".join(tokens(row["matched_player_name"]))
        return " ".join(tokens(row.get("player_name_raw","")))
    df["player_name_normalized"] = df.apply(normalized_player_name, axis=1)

    # 8) Write to DB
    engine = get_engine(conn)
    # Use a transaction to replace atomically
    with engine.begin() as conn:
        # Create a temp table, then swap (safer than replace in-flight)
        tmp_table = f"{args.table}_tmp"
        df.to_sql(tmp_table, con=conn, if_exists="replace", index=False)

        # Optional helpful indexes
        for stmt in [
            f'CREATE INDEX IF NOT EXISTS idx_{tmp_table}_team ON "{tmp_table}" (team);',
            f'CREATE INDEX IF NOT EXISTS idx_{tmp_table}_playername ON "{tmp_table}" (player_name_normalized);',
            f'CREATE INDEX IF NOT EXISTS idx_{tmp_table}_fbref ON "{tmp_table}" (fbref_id);',
            f'CREATE INDEX IF NOT EXISTS idx_{tmp_table}_understat ON "{tmp_table}" (understat_id);'
        ]:
            conn.execute(text(stmt))

        # Swap
        conn.execute(text(f'DROP TABLE IF EXISTS "{args.table}"'))
        conn.execute(text(f'ALTER TABLE "{tmp_table}" RENAME TO "{args.table}"'))

    print(f"Inserted {len(df)} rows into {args.table}.")

    return gameweek

def insert_fpl_elements(conn):
    gameweek = main(conn)
    return int(gameweek) - 1

# if __name__ == "__main__":
#     try:
#         main()
#     except KeyboardInterrupt:
#         sys.exit(130)

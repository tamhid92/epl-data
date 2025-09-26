#!/usr/bin/env python3
# -*- coding: utf-8 -*-

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

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine, Connection


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

DB_HOST = os.environ.get("DB_HOST")
DB_PORT = os.environ.get("DB_PORT")
DB_NAME = os.environ.get("DB_NAME")
DB_USER = os.environ.get("DB_USER")
DB_PASS = os.environ.get("DB_PASS")

# ---------- Normalization ----------

_WS_RE = re.compile(r"\s+")
_PUNCT_RE = re.compile(r"[^\w\s-]") 

def get_conn_string() -> str:
    return f"postgresql+psycopg2://{DB_USER}:{DB_PASS}@{DB_HOST}:{DB_PORT}/{DB_NAME}"

def get_engine() -> Engine:
    return create_engine(get_conn_string(), future=True, pool_pre_ping=True)

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
    """Split hyphenated parts into alternatives (e.g., 'jean-pierre' -> ['jean pierre','jean','pierre'])."""
    n = norm(name)
    if "-" not in n:
        return [n]
    parts = [p for p in n.split("-") if p]
    out = [" ".join(parts)]
    out.extend(parts)
    return sorted(set(out))

NICKNAMES = {
    "alex":"alexander", "sasha":"alexander",
    "will":"william", "bill":"william", "billy":"william", "liam":"william",
    "ben":"benjamin", "jamie":"james", "jim":"james",
    "joe":"joseph", "josh":"joshua", "matty":"matthew", "matt":"matthew",
    "toni":"antonio","tony":"anthony",
    "harry":"harold",
    "nick":"nicholas","nico":"nicholas",
    "luiz":"luis","lucho":"luis",
}

def expand_given(name: str) -> List[str]:
    f, l = first_last(name)
    alt = NICKNAMES.get(f, None)
    out = [name]
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

    variants = set()
    variants.add(" ".join(ts_nc) if ts_nc else base)
    if f or l:
        variants.add(f"{f} {l}".strip())
        variants.add(f"{f[:1]} {l}".strip() if f else l)
        variants.add(l)  # surname only
        variants.add(f"{l} {f}".strip())
    # hyphen handling
    for piece in hyphen_splits(" ".join(ts_nc) if ts_nc else base):
        variants.add(piece)
    # nickname expansion on given name
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
    # fallback
    return float(SequenceMatcher(None, a, b).ratio())

# ---------- Team canonicalization ----------

SHORT_TO_NAME = {
    "ARS": "Arsenal", "AVL": "Aston Villa", "BOU": "Bournemouth", "BRE": "Brentford",
    "BHA": "Brighton", "BUR": "Burnley", "CHE": "Chelsea", "CRY": "Crystal Palace",
    "EVE": "Everton", "FUL": "Fulham", "LEE": "Leeds", "LIV": "Liverpool",
    "MCI": "Manchester City", "MUN": "Manchester United", "NEW": "Newcastle United",
    "NFO": "Nottingham Forest", "TOT": "Tottenham", "WHU": "West Ham",
    "WOL": "Wolverhampton Wanderers",
    "LEI":"Leicester City","SOU":"Southampton","NOR":"Norwich City","WAT":"Watford",
    "SHE":"Sheffield United","IPS":"Ipswich Town","SUN":"Sunderland",
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

# ---------- Fetch & flatten API ----------

def fetch_teams(teams_url: str) -> pd.DataFrame:
    data = requests.get(teams_url, timeout=30).json()
    rows = []
    for t in data if isinstance(data, list) else []:
        name = t.get("team_name", "")
        rows.append({"team_id": t.get("team_id",""), "team_name": name, "norm_team": norm(name)})
    return pd.DataFrame(rows)

def fetch_players(players_url: str) -> List[Dict[str, Any]]:
    data = requests.get(players_url, timeout=60).json()
    if isinstance(data, list) and data and isinstance(data[0], dict) and "get_all_players_stats" in data[0]:
        return data[0]["get_all_players_stats"]
    if isinstance(data, list):
        return data
    for v in (data.values() if isinstance(data, dict) else []):
        if isinstance(v, list) and v and isinstance(v[0], dict) and ("fbref" in v[0] or "player_name" in v[0]):
            return v
    raise RuntimeError("Unrecognized players payload shape; expected data[0]['get_all_players_stats'].")

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
            found = False
            for key in preferred:
                sub = fbref_block.get(key)
                if isinstance(sub, dict) and "team_name" in sub:
                    fbref_team = sub.get("team_name") or fbref_team
                    found = True
                    break
            if not found:
                for sub in fbref_block.values():
                    if isinstance(sub, dict) and "team_name" in sub:
                        fbref_team = sub.get("team_name") or fbref_team

        cat_team = fbref_team or understat_team
        f, l = first_last(pname)
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

# ---------- Scoring ----------

def score_pair(a: str, b: str) -> float:
    a_n = norm(a); b_n = norm(b)
    if not a_n or not b_n:
        return 0.0

    # Base similarities
    jw = jaro_winkler(a_n, b_n)  # 0..1

    if fuzz is not None:
        try:
            w = fuzz.WRatio(a_n, b_n) / 100.0
            ts = fuzz.token_set_ratio(a_n, b_n) / 100.0
            tr = fuzz.token_sort_ratio(a_n, b_n) / 100.0
        except Exception:
            w = ts = tr = 0.0
    else:
        # fall back to difflib approximations
        w = SequenceMatcher(None, a_n, b_n).ratio()
        ts = w
        tr = w

    # Weighted blend (tuned generously)
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

        # Bonuses
        bonus = 0.0
        # exact surname match
        if l_pred and l_cand and l_pred == l_cand:
            bonus += 0.05
        # first initial match
        if f_pred and cand_row.get("player_name",""):
            cf, _ = first_last(cand_row["player_name"])
            if cf and f_pred[:1] == cf[:1]:
                bonus += 0.03
        # phonetic surname bonus
        if ph_pred and ph_cand and ph_pred == ph_cand:
            bonus += 0.03

        s_final = min(1.0, s + bonus)

        if s_final > best:
            best = s_final
            best_var = v

    dbg = f"base_best_on='{best_var}', score={best:.3f}"
    return best, dbg

# ---------- Matching ----------

def match_player_row(pred_name: str,
                     team_name: str,
                     catalog: pd.DataFrame,
                     team_threshold: float = 0.84,
                     global_threshold: float = 0.88) -> Tuple[str, str, str, str, float, str]:

    tnorm = norm(team_name)

    # Step 1: restrict to same team (if known)
    sub = catalog[catalog["norm_team"] == tnorm] if tnorm else pd.DataFrame(columns=catalog.columns)

    def pick_best(df: pd.DataFrame) -> Tuple[pd.Series|None, float, str]:
        best_row = None
        best_score = 0.0
        best_dbg = ""
        for _, r in df.iterrows():
            s, dbg = score_player(pred_name, r)
            if s > best_score:
                best_score, best_row, best_dbg = s, r, dbg
        return best_row, best_score, best_dbg

    if not sub.empty:
        r, score, dbg = pick_best(sub)
        if r is not None and score >= team_threshold:
            return (r["fbref_id"] or "", r["understat_id"] or "",
                    r["player_name"], r["catalog_team_name"], "team_block", float(score), dbg)

    # Step 2: global fallback (expensive)
    r, score, dbg = pick_best(catalog)
    if r is not None and score >= global_threshold:
        return (r["fbref_id"] or "", r["understat_id"] or "",
                r["player_name"], r["catalog_team_name"], "global", float(score), dbg)

    return "", "", "", "", "none", 0.0, "no match above thresholds"

# ---------- Main ----------

def main():
    print("Running main()")
    ap = argparse.ArgumentParser()
    ap.add_argument("--predictions", default="predictions_next_gw.csv")
    ap.add_argument("--players-url", default="http://192.168.68.76:8000/fbref/players")
    ap.add_argument("--teams-url", default="http://192.168.68.76:8000/teams")
    ap.add_argument("--out", default="predictions_next_gw_enriched.csv")
    ap.add_argument("--write-unmatched", action="store_true", help="also write unmatched_players.csv")
    ap.add_argument("--team-threshold", type=float, default=0.84)
    ap.add_argument("--global-threshold", type=float, default=0.88)
    args = ap.parse_args()

    # Load inputs
    preds = pd.read_csv(args.predictions)
    teams_df = fetch_teams(args.teams_url)
    team_normset = set(teams_df["norm_team"].tolist())

    # Normalize team/opponent
    preds["canonical_team_name"] = preds["team"].apply(lambda x: normalize_team(x, team_normset))
    if "next_opponent" in preds.columns:
        preds["canonical_opponent_name"] = preds["next_opponent"].apply(lambda x: normalize_team(x, team_normset))
    else:
        preds["canonical_opponent_name"] = ""

    # Fetch & flatten players
    players_list = fetch_players(args.players_url)
    catalog = flatten_players(players_list)

    # Build outputs
    fb_ids, us_ids, mnames, mteams, methods, confs, dbgs = [], [], [], [], [], [], []
    unmatched = []

    for _, row in preds.iterrows():
        pname = row.get("name","")
        tname = row.get("canonical_team_name", row.get("team",""))
        fb, us, mp, mt, method, conf, dbg = match_player_row(
            pname, tname, catalog,
            team_threshold=args.team_threshold,
            global_threshold=args.global_threshold
        )
        fb_ids.append(fb)
        us_ids.append(us)
        mnames.append(mp)
        mteams.append(mt)
        methods.append(method)
        confs.append(conf)
        dbgs.append(dbg)

        if not fb and not us:
            unmatched.append({
                "name": pname,
                "team": row.get("team",""),
                "canonical_team": tname,
                "normalized_player": norm(pname),
                "normalized_team": norm(tname),
                "debug": dbg
            })

    preds["fbref_id"] = fb_ids
    preds["understat_id"] = us_ids
    preds["matched_player_name"] = mnames
    preds["matched_team_from_catalog"] = mteams
    preds["match_method"] = methods
    preds["match_confidence"] = confs
    preds["match_debug"] = dbgs

    engine = get_engine()

    # Optional: attach team_id from teams list
    tmap = {r["norm_team"]: r["team_id"] for _, r in teams_df.iterrows()}
    preds["team_id"] = preds["canonical_team_name"].apply(lambda n: tmap.get(norm(n), ""))

    out_path = Path(args.out)
    preds.to_csv(out_path, index=False)
    preds.to_sql("predicted_next_gw", con=engine, if_exists='replace', index=False)
    print(f"Enriched CSV: {out_path.resolve()} (rows={len(preds)})")

    if args.write_unmatched:
        um = pd.DataFrame(unmatched)
        um_path = out_path.with_name("unmatched_players.csv")
        um.to_csv(um_path, index=False)
        print(f"Unmatched CSV: {um_path.resolve()} (rows={len(um)})")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)

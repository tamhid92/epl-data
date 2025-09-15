import os, re, unicodedata, logging, uuid
import pandas as pd
from sqlalchemy import create_engine, text

LOG = logging.getLogger("link_xref")
LOG.setLevel(getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper()))

try:
    from rapidfuzz import fuzz, process
    HAVE_RF = True
except Exception:
    import difflib
    HAVE_RF = False

# ───────────────────────────── normalize helpers
_punct = re.compile(r"[^\w\s]")
_ws = re.compile(r"\s+")
ALIASES = {
    "Newcastle Utd": "Newcastle United",
    "Nott'ham Forest": "Nottingham Forest",
    "Man Utd": "Manchester United",
    "Man City": "Manchester City",
    "Spurs": "Tottenham",
    "Wolves": "Wolverhampton Wanderers",
    "Leeds United": "Leeds",
}
def _norm(s: str) -> str:
    if s is None: return ""
    s = str(s).strip().lower()
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = _punct.sub(" ", s)
    s = _ws.sub(" ", s).strip()
    return s
def _norm_team(s: str) -> str:
    s2 = _norm(s)
    return ALIASES.get(s2, s2)

def _sim(a, b):
    if HAVE_RF:
        return float(fuzz.token_set_ratio(a, b))
    return 100.0 * difflib.SequenceMatcher(None, a, b).ratio()

# ───────────────────────────── schema utilities
FBREF_CATEGORIES = [
    "standard","goalkeeping","shooting","passing",
    "pass types","goal and shot creation","defensive","possession",
]
def _existing_tables(engine):
    q = """select table_name from information_schema.tables
           where table_schema='public'"""
    return set(pd.read_sql(q, engine)['table_name'].tolist())

def _pick_fbref_player_table(engine) -> str:
    tables = _existing_tables(engine)
    # prefer player_standard; else first available category
    prefs = ["player_standard"] + [f"player_{c.replace(' ','_')}" for c in FBREF_CATEGORIES]
    for t in prefs:
        if t in tables:
            LOG.info("Using FBref player table: %s", t)
            return t
    raise RuntimeError("Could not find any FBref player_* table.")

def _columns(engine, table):
    q = """select column_name from information_schema.columns
           where table_schema='public' and table_name=%s"""
    cols = pd.read_sql(q, engine, params=(table,))['column_name'].tolist()
    # map lower->actual for resilient lookup
    return {c.lower(): c for c in cols}

def _get_col(cols, *candidates):
    for c in candidates:
        if c in cols: return cols[c]
    raise KeyError(f"Missing required column (tried {candidates})")

# ───────────────────────────── xrefs
def build_team_xref(engine):
    teams = pd.read_sql('select team_id, team_name from epl_teams', engine)
    teams['norm_name'] = teams['team_name'].map(_norm_team)

    # use team_standard if present; else derive from any team_* table
    table = "team_standard" if "team_standard" in _existing_tables(engine) else None
    if table is None:
        candidates = [f"team_{c.replace(' ','_')}" for c in FBREF_CATEGORIES]
        for t in candidates:
            if t in _existing_tables(engine):
                table = t; break
    if table is None:
        raise RuntimeError("No FBref team_* table found to build team_xref.")

    fb = pd.read_sql(f'select distinct "team_name" as fbref_name, "team_id_x" as fbref_team_id from "{table}"', engine)
    fb.columns = [c.lower() for c in fb.columns]
    fb['norm_name'] = fb['fbref_name'].map(_norm_team)

    merged = fb.merge(teams, left_on='norm_name', right_on='norm_name', how='left')
    # fuzzy map any leftovers
    missing = merged[merged['team_id'].isna()]
    if not missing.empty:
        cand = list(teams['norm_name'].unique())
        fixes = []
        for _, r in missing.iterrows():
            if HAVE_RF:
                best = process.extractOne(r['norm_name'], cand, scorer=fuzz.token_set_ratio)
                choice, score = (best[0], best[1]) if best else ("", 0.0)
            else:
                choice, score = max(((c, _sim(r['norm_name'], c)) for c in cand), key=lambda x: x[1])
            if score >= 90:
                trow = teams.loc[teams['norm_name']==choice].iloc[0]
                fixes.append({
                    "fbref_name": r["fbref_name"],
                    "fbref_team_id": r["fbref_team_id"],
                    "team_id": trow["team_id"],
                    "team_name": trow["team_name"],
                })
        if fixes:
            fixed = pd.DataFrame(fixes)
            ok = merged[~merged['team_id'].isna()][['fbref_name','fbref_team_id','team_id','team_name']]
            merged = pd.concat([ok, fixed], ignore_index=True)

    out = merged.dropna(subset=['team_id'])[['fbref_team_id','fbref_name','team_id','team_name']].drop_duplicates()
    out.to_sql("team_xref", engine, if_exists="replace", index=False)
    with engine.begin() as c:
        c.execute(text('CREATE INDEX IF NOT EXISTS idx_team_xref_fbref ON team_xref(fbref_team_id)'))
        c.execute(text('CREATE INDEX IF NOT EXISTS idx_team_xref_team ON team_xref(team_id)'))
    LOG.info("team_xref rows: %d", len(out))

def _load_fbref_players(engine, table) -> pd.DataFrame:
    cols = _columns(engine, table)
    pid = _get_col(cols, 'player id', 'player_id', )
    pname = _get_col(cols, 'player', 'player_name', 'name')
    squad = _get_col(cols, 'squad', 'team_name', 'team_title')
    pos = cols.get('pos') or cols.get('position')  # optional

    sel = f'SELECT DISTINCT "{pid}"::text AS fbref_player_id, "{pname}" AS fbref_name, "{squad}" AS fbref_team'
    if pos: sel += f', "{pos}" AS fbref_pos'
    else:   sel += ', NULL::text AS fbref_pos'
    sel += f' FROM "{table}"'
    df = pd.read_sql(sel, engine)
    df.columns = [c.lower() for c in df.columns]
    return df

def build_player_xref(engine, strict=97, fuzzy=90):
    # team map
    tx = pd.read_sql('select team_id, team_name, fbref_team_id, fbref_name from team_xref', engine)
    tx['norm_team'] = tx['team_name'].map(_norm_team)

    # understat players
    up = pd.read_sql("""
        select id::text as understat_player_id,
               player_name, team_title, coalesce(position,'') as position
        from players
    """, engine)
    up['norm_name'] = up['player_name'].map(_norm)
    up['norm_team'] = up['team_title'].map(_norm_team)
    up = up.merge(tx[['team_id','norm_team']].drop_duplicates('team_id'),
                  on='norm_team', how='left')
    up = up.rename(columns={'team_id': 'understat_team_id'})

    # fbref players (from chosen table) + attach canonical team_id
    fb_table = _pick_fbref_player_table(engine)
    fp = _load_fbref_players(engine, fb_table)
    fp['norm_name'] = fp['fbref_name'].map(_norm)
    fp['norm_team'] = fp['fbref_team'].map(_norm_team)
    fp = fp.merge(
        tx[['fbref_team_id','norm_team','team_id']].rename(columns={'team_id':'fbref_team_id_canon'}),
        on='norm_team', how='left'
    )

    fb_by_team = {t: df for t, df in fp.groupby('fbref_team_id_canon')}

    xrows, umiss = [], []
    for _, r in up.iterrows():
        u_name = r['norm_name']; u_team = r['understat_team_id']
        cands = fb_by_team.get(u_team)
        if cands is None or cands.empty:
            umiss.append({"understat_player_id": r['understat_player_id'],
                          "player_name": r['player_name'],
                          "understat_team_id": u_team,
                          "reason": "no_team_candidates"})
            continue

        exact = cands[cands['norm_name'] == u_name]
        if len(exact) == 1:
            ex = exact.iloc[0]
            xrows.append({
                "canonical_player_id": str(uuid.uuid4()),
                "understat_player_id": r['understat_player_id'],
                "fbref_player_id": ex['fbref_player_id'],
                "understat_name": r['player_name'],
                "fbref_name": ex['fbref_name'],
                "understat_team_id": u_team,
                "fbref_team_id": ex['fbref_team_id_canon'],
                "method": "exact_norm_same_team",
                "confidence": 100.0
            })
            continue
        elif len(exact) > 1:
            # tie-break on first letter of position if we have it
            pos = (r.get('position') or "").lower()[:1]
            ex2 = exact.copy()
            if pos:
                ex2['pos_match'] = ex2['fbref_pos'].fillna("").str.lower().str.startswith(pos)
                ex2 = ex2.sort_values(by=['pos_match'], ascending=False)
            ex = ex2.iloc[0]
            xrows.append({
                "canonical_player_id": str(uuid.uuid4()),
                "understat_player_id": r['understat_player_id'],
                "fbref_player_id": ex['fbref_player_id'],
                "understat_name": r['player_name'],
                "fbref_name": ex['fbref_name'],
                "understat_team_id": u_team,
                "fbref_team_id": ex['fbref_team_id_canon'],
                "method": "exact_norm_same_team_tiebreak",
                "confidence": 99.0
            })
            continue

        # fuzzy within team
        cand = cands.copy()
        cand['score'] = cand['norm_name'].map(lambda n: _sim(u_name, n))
        cand = cand.sort_values('score', ascending=False)
        top = cand.iloc[0]
        if top['score'] >= strict:
            method = 'fuzzy_strict_same_team'
        elif top['score'] >= fuzzy:
            method = 'fuzzy_same_team'
        else:
            umiss.append({"understat_player_id": r['understat_player_id'],
                          "player_name": r['player_name'],
                          "understat_team_id": u_team,
                          "best_candidate": top['fbref_name'],
                          "best_score": float(top['score']),
                          "reason": "low_score"})
            continue

        xrows.append({
            "canonical_player_id": str(uuid.uuid4()),
            "understat_player_id": r['understat_player_id'],
            "fbref_player_id": top['fbref_player_id'],
            "understat_name": r['player_name'],
            "fbref_name": top['fbref_name'],
            "understat_team_id": u_team,
            "fbref_team_id": top['fbref_team_id_canon'],
            "method": method,
            "confidence": float(top['score']),
        })

    xdf = pd.DataFrame(xrows)
    udf = pd.DataFrame(umiss)
    xdf.to_sql("player_xref", engine, if_exists="replace", index=False)
    udf.to_sql("player_xref_unmatched", engine, if_exists="replace", index=False)
    with engine.begin() as c:
        c.execute(text('CREATE INDEX IF NOT EXISTS idx_xref_understat ON player_xref(understat_player_id)'))
        c.execute(text('CREATE INDEX IF NOT EXISTS idx_xref_fbref ON player_xref(fbref_player_id)'))
    LOG.info("player_xref=%d, unmatched=%d", len(xdf), len(udf))

def build_xrefs(engine):
    with engine.begin() as c:
        c.execute(text('CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_title)'))
    build_team_xref(engine)
    build_player_xref(engine)

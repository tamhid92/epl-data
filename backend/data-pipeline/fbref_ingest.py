from __future__ import annotations

import ast
import re
from typing import Dict, Any, Iterable, Tuple
import pandas as pd
from sqlalchemy.engine import Engine

# ------------------ key flattening helpers ------------------

def _parse_key(k: str) -> Tuple[str, ...] | None:
    """Parse a string that looks like a tuple key: "('Foo','Bar')" -> ('Foo','Bar')."""
    if isinstance(k, str) and k.startswith("(") and k.endswith(")"):
        try:
            t = ast.literal_eval(k)
            return t if isinstance(t, tuple) else None
        except Exception:
            return None
    return None

def _clean_key(k: str) -> str:
    """
    Normalize fbref-like multiindex keys to snake_case **lowercase**:
      - ("Unnamed: 2_level_0", "Age")   -> "age"        (take index 1)
      - ("Unnamed: 0_level_0", "Squad") -> "squad"
      - ("Team ID","")                  -> "team_id"
      - ("Per 90 Minutes","Gls")        -> "per_90_minutes_gls"
    """
    t = _parse_key(k)

    if t:
        if (
            len(t) >= 2
            and isinstance(t[0], str)
            and re.match(r"^Unnamed:\s*\d+_level_0$", t[0])
        ):
            name = str(t[1] or "")
        elif len(t) >= 2 and t[1] == "Squad":
            name = "Squad"
        elif t[0] == "Team ID":
            name = "Team_ID"
        elif t[0] in ("Player Link", "Player ID"):
            name = t[0].replace(" ", "_")
        else:
            name = "_".join([str(part) for part in t if part])
    else:
        name = str(k)

    # sanitize, then LOWERCASE
    name = name.strip()
    name = name.replace("%", "pct").replace("+", "plus")
    name = re.sub(r"[^\w]+", "_", name)
    name = re.sub(r"_+", "_", name).strip("_")
    return name.lower()


def _flatten_one(rec: Dict[str, Any]) -> Dict[str, Any]:
    """Flatten one record's keys."""
    out = {}
    for k, v in rec.items():
        out[_clean_key(k)] = v
    return out

def _flatten_many(rows: Iterable[Dict[str, Any]]) -> pd.DataFrame:
    return pd.DataFrame([_flatten_one(r) for r in rows])


# ------------------ team normalization ------------------

_CANON_REPLACEMENTS = {
    " Utd": " United",
    "Nott'ham": "Nottingham",
    "Spurs": "Tottenham",
    "Wolves": "Wolverhampton Wanderers",
    "Man City": "Manchester City",
    "Man Utd": "Manchester United",
    "Leeds United": "Leeds",
}

def _normalize_text_name(raw: str) -> str:
    """Cheap canonicalizer before DB lookups."""
    if raw is None:
        return raw
    name = raw.strip()
    if name.lower().startswith("vs "):
        name = name[3:]  # drop "vs "
    for a, b in _CANON_REPLACEMENTS.items():
        name = name.replace(a, b)
    # collapse whitespace
    name = " ".join(name.split())
    return name

def _load_team_maps(engine: Engine) -> Tuple[pd.DataFrame, Dict[str, str]]:
    """
    Returns:
      - teams_df: columns [team_id, team_name]
      - alias_map: dict lower(alias) -> canonical team_name
    """
    with engine.connect() as conn:
        teams_df = pd.read_sql('SELECT team_id, team_name FROM epl_teams;', conn)

        alias_map = {}
        try:
            alias_df = pd.read_sql('SELECT alias, team_name FROM team_alias;', conn)
            alias_map = {str(a).lower(): t for a, t in alias_df.itertuples(index=False)}
        except Exception:
            pass

    for t in teams_df["team_name"]:
        alias_map.setdefault(str(t).lower(), t)
    return teams_df, alias_map

def _attach_team_id(df: pd.DataFrame, teams_df: pd.DataFrame, name_col: str = "Squad") -> pd.DataFrame:
    df = df.copy()
    if name_col not in df.columns:
        return df
    df["team_name"] = df[name_col].astype(str).map(_normalize_text_name)
    df = df.merge(teams_df.rename(columns={"team_name": "team_name"}),
                  on="team_name", how="left") 
    return df


# ------------------ main ingest ------------------

def ingest_fbref_bundle(
    engine: Engine,
    bundle: Dict[str, Any],
    *,
    category: str = "standard",
    if_exists: str = "replace",
) -> None:
    """
    Ingest a bundle shaped like:
      {
        "standard": {
          "team": [...],
          "vs_team": [...],
          "players": [...]
        }
      }
    Writes:
      team_<category>, vs_team_<category>, player_<category>
    """
    if category not in bundle:
        raise KeyError(f'Category "{category}" not in bundle keys: {list(bundle.keys())}')

    block = bundle[category]
    teams_df, alias_map = _load_team_maps(engine)

    # --- TEAM ---
    team_rows = block.get("team") or []
    team_df = _flatten_many(team_rows)
    if not team_df.empty:
        if "squad" in team_df.columns:

            team_df["team_name"] = (team_df["squad"]
                                    .astype(str)
                                    .map(_normalize_text_name)
                                    .map(lambda s: alias_map.get(s.lower(), s)))

            team_df.drop(columns=["squad"], inplace=True)

            team_df = team_df.merge(teams_df, on="team_name", how="left")
    

        team_df = team_df.loc[:, ~team_df.columns.duplicated()]
        team_df = team_df.apply(pd.to_numeric, errors="ignore")
        team_table = f"team_{category.replace(' ', '_')}"
        # team_df.drop(columns=["team_id"], inplace=True)
        team_df.to_sql(team_table, con=engine, if_exists=if_exists, index=False)

    # --- VS TEAM ---
    vs_rows = block.get("vs_team") or []
    vs_df = _flatten_many(vs_rows)
    if not vs_df.empty:
        if "squad" in vs_df.columns:
            vs_df["team_name"] = (vs_df["squad"]
                                  .astype(str)
                                  .map(_normalize_text_name)
                                  .map(lambda s: alias_map.get(s.lower(), s)))
            vs_df.drop(columns=["squad"], inplace=True)
            vs_df = vs_df.merge(teams_df, on="team_name", how="left")
    
        vs_df = vs_df.loc[:, ~vs_df.columns.duplicated()]
        vs_df = vs_df.apply(pd.to_numeric, errors="ignore")
        vs_table = f"vs_team_{category.replace(' ', '_')}"
        vs_df.to_sql(vs_table, con=engine, if_exists=if_exists, index=False)

    # --- PLAYERS ---
    players_rows = block.get("players") or []
    players_df = _flatten_many(players_rows)
    if not players_df.empty:
        if "squad" in players_df.columns:
            players_df["team_name"] = (players_df["squad"]
                                       .astype(str)
                                       .map(_normalize_text_name)
                                       .map(lambda s: alias_map.get(s.lower(), s)))
            players_df.drop(columns=["squad"], inplace=True)
            players_df = players_df.merge(teams_df, on="team_name", how="left")
    
        players_df = players_df.loc[:, ~players_df.columns.duplicated()]
        players_df = players_df.apply(pd.to_numeric, errors="ignore")
        player_table = f"player_{category.replace(' ', '_')}"
        players_df.drop(columns=["rk","matches","player_link"], inplace=True)
        players_df.to_sql(player_table, con=engine, if_exists=if_exists, index=False)


# ------------------ optional: bootstrap alias table ------------------

DDL_TEAM_ALIAS = """
CREATE TABLE IF NOT EXISTS team_alias (
  alias TEXT PRIMARY KEY,
  team_name TEXT NOT NULL REFERENCES epl_teams(team_name) ON UPDATE CASCADE
);
"""

# Example seeds you can insert once to reduce mismatches:
DEFAULT_ALIAS_SEEDS = {
    "Newcastle Utd": "Newcastle United",
    "Nott'ham Forest": "Nottingham Forest",
    "Man Utd": "Manchester United",
    "Man City": "Manchester City",
    "Spurs": "Tottenham",
    "Wolves": "Wolverhampton Wanderers",
    "Leeds United": "Leeds",
}

def ensure_alias_table(engine: Engine, seeds: Dict[str, str] | None = None) -> None:
    with engine.begin() as conn:
        conn.exec_driver_sql(DDL_TEAM_ALIAS)
        if seeds:
            for alias, canonical in seeds.items():
                conn.exec_driver_sql(
                    "INSERT INTO team_alias(alias, team_name) VALUES (%s, %s) "
                    "ON CONFLICT (alias) DO NOTHING;",
                    (alias, canonical),
                )
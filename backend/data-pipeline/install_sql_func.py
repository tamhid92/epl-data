import sys
from sqlalchemy import create_engine
from typing import Iterable
from sqlalchemy.engine import Engine

# ---------------------- SQL blocks (functions) ----------------------

SQL_CREATE_UNACCENT = """
CREATE EXTENSION IF NOT EXISTS unaccent;
"""

SQL_CREATE_IMM_UNACCENT = """
CREATE OR REPLACE FUNCTION public.imm_unaccent(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$ SELECT unaccent('public.unaccent', $1) $$;
"""

SQL_CREATE_GET_FBREF_TEAM_JSON_ALL = r"""
CREATE OR REPLACE FUNCTION public.get_fbref_team_json_all()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
WITH base AS (
  SELECT DISTINCT ON (name_norm) name_norm, team_name
  FROM (
    SELECT lower(imm_unaccent(team_name)) AS name_norm, team_name FROM team_standard
    UNION SELECT lower(imm_unaccent(team_name)), team_name FROM team_goalkeeping
    UNION SELECT lower(imm_unaccent(team_name)), team_name FROM team_shooting
    UNION SELECT lower(imm_unaccent(team_name)), team_name FROM team_passing
    UNION SELECT lower(imm_unaccent(team_name)), team_name FROM team_pass_types
    UNION SELECT lower(imm_unaccent(team_name)), team_name FROM team_goal_and_shot_creation
    UNION SELECT lower(imm_unaccent(team_name)), team_name FROM team_defensive
    UNION SELECT lower(imm_unaccent(team_name)), team_name FROM team_possession
  ) u
  ORDER BY name_norm, team_name
),
joined AS (
  SELECT
    b.team_name,
    CASE WHEN ts.team_name  IS NULL THEN NULL ELSE to_jsonb(ts)  - 'team_name' END AS standard,
    CASE WHEN tg.team_name  IS NULL THEN NULL ELSE to_jsonb(tg)  - 'team_name' END AS goalkeeping,
    CASE WHEN tsh.team_name IS NULL THEN NULL ELSE to_jsonb(tsh) - 'team_name' END AS shooting,
    CASE WHEN tp.team_name  IS NULL THEN NULL ELSE to_jsonb(tp)  - 'team_name' END AS passing,
    CASE WHEN tpt.team_name IS NULL THEN NULL ELSE to_jsonb(tpt) - 'team_name' END AS pass_types,
    CASE WHEN tgc.team_name IS NULL THEN NULL ELSE to_jsonb(tgc) - 'team_name' END AS goal_and_shot_creation,
    CASE WHEN td.team_name  IS NULL THEN NULL ELSE to_jsonb(td)  - 'team_name' END AS defensive,
    CASE WHEN tpo.team_name IS NULL THEN NULL ELSE to_jsonb(tpo) - 'team_name' END AS possession
  FROM base b
  LEFT JOIN team_standard                ts  ON lower(imm_unaccent(ts.team_name))  = b.name_norm
  LEFT JOIN team_goalkeeping             tg  ON lower(imm_unaccent(tg.team_name))  = b.name_norm
  LEFT JOIN team_shooting               tsh  ON lower(imm_unaccent(tsh.team_name)) = b.name_norm
  LEFT JOIN team_passing                 tp  ON lower(imm_unaccent(tp.team_name))  = b.name_norm
  LEFT JOIN team_pass_types             tpt  ON lower(imm_unaccent(tpt.team_name)) = b.name_norm
  LEFT JOIN team_goal_and_shot_creation tgc  ON lower(imm_unaccent(tgc.team_name)) = b.name_norm
  LEFT JOIN team_defensive               td  ON lower(imm_unaccent(td.team_name))  = b.name_norm
  LEFT JOIN team_possession             tpo  ON lower(imm_unaccent(tpo.team_name)) = b.name_norm
)
SELECT jsonb_object_agg(
  team_name,
  jsonb_strip_nulls(
    jsonb_build_object(
      'standard', standard,
      'goalkeeping', goalkeeping,
      'shooting', shooting,
      'passing', passing,
      'pass_types', pass_types,
      'goal_and_shot_creation', goal_and_shot_creation,
      'defensive', defensive,
      'possession', possession
    )
  )
)
FROM joined;
$$;
"""

SQL_CREATE_GET_FBREF_VS_TEAM_JSON_ALL = r"""
CREATE OR REPLACE FUNCTION public.get_fbref_vs_team_json_all()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
WITH base AS (
  SELECT DISTINCT ON (name_norm) name_norm, team_name
  FROM (
    SELECT lower(imm_unaccent(team_name)) AS name_norm, team_name FROM vs_team_standard
    UNION SELECT lower(imm_unaccent(team_name)), team_name FROM vs_team_goalkeeping
    UNION SELECT lower(imm_unaccent(team_name)), team_name FROM vs_team_shooting
    UNION SELECT lower(imm_unaccent(team_name)), team_name FROM vs_team_passing
    UNION SELECT lower(imm_unaccent(team_name)), team_name FROM vs_team_pass_types
    UNION SELECT lower(imm_unaccent(team_name)), team_name FROM vs_team_goal_and_shot_creation
    UNION SELECT lower(imm_unaccent(team_name)), team_name FROM vs_team_defensive
    UNION SELECT lower(imm_unaccent(team_name)), team_name FROM vs_team_possession
  ) u
  ORDER BY name_norm, team_name
),
joined AS (
  SELECT
    b.team_name,
    CASE WHEN vts.team_name  IS NULL THEN NULL ELSE to_jsonb(vts)  - 'team_name' END AS standard,
    CASE WHEN vtg.team_name  IS NULL THEN NULL ELSE to_jsonb(vtg)  - 'team_name' END AS goalkeeping,
    CASE WHEN vtsh.team_name IS NULL THEN NULL ELSE to_jsonb(vtsh) - 'team_name' END AS shooting,
    CASE WHEN vtp.team_name  IS NULL THEN NULL ELSE to_jsonb(vtp)  - 'team_name' END AS passing,
    CASE WHEN vtpt.team_name IS NULL THEN NULL ELSE to_jsonb(vtpt) - 'team_name' END AS pass_types,
    CASE WHEN vtgc.team_name IS NULL THEN NULL ELSE to_jsonb(vtgc) - 'team_name' END AS goal_and_shot_creation,
    CASE WHEN vtd.team_name  IS NULL THEN NULL ELSE to_jsonb(vtd)  - 'team_name' END AS defensive,
    CASE WHEN vtpo.team_name IS NULL THEN NULL ELSE to_jsonb(vtpo) - 'team_name' END AS possession
  FROM base b
  LEFT JOIN vs_team_standard                vts ON lower(imm_unaccent(vts.team_name))  = b.name_norm
  LEFT JOIN vs_team_goalkeeping             vtg ON lower(imm_unaccent(vtg.team_name))  = b.name_norm
  LEFT JOIN vs_team_shooting               vtsh ON lower(imm_unaccent(vtsh.team_name)) = b.name_norm
  LEFT JOIN vs_team_passing                 vtp ON lower(imm_unaccent(vtp.team_name))  = b.name_norm
  LEFT JOIN vs_team_pass_types             vtpt ON lower(imm_unaccent(vtpt.team_name)) = b.name_norm
  LEFT JOIN vs_team_goal_and_shot_creation vtgc ON lower(imm_unaccent(vtgc.team_name)) = b.name_norm
  LEFT JOIN vs_team_defensive               vtd ON lower(imm_unaccent(vtd.team_name))  = b.name_norm
  LEFT JOIN vs_team_possession             vtpo ON lower(imm_unaccent(vtpo.team_name)) = b.name_norm
)
SELECT jsonb_object_agg(
  team_name,
  jsonb_strip_nulls(
    jsonb_build_object(
      'standard', standard,
      'goalkeeping', goalkeeping,
      'shooting', shooting,
      'passing', passing,
      'pass_types', pass_types,
      'goal_and_shot_creation', goal_and_shot_creation,
      'defensive', defensive,
      'possession', possession
    )
  )
)
FROM joined;
$$;
"""

SQL_CREATE_GET_PLAYER_ALL_STATS = r"""
CREATE OR REPLACE FUNCTION public.get_player_all_stats(p_name text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
WITH target AS (
  SELECT id::text AS understat_player_id,
         player_name,
         team_title
  FROM players
  WHERE lower(player_name) = lower(p_name)
  ORDER BY player_name
  LIMIT 1
),
x AS (  -- best xref row (highest confidence)
  SELECT px.*
  FROM player_xref px
  JOIN target t ON t.understat_player_id = px.understat_player_id
  ORDER BY confidence DESC
  LIMIT 1
),
-- Use DISTINCT ON to avoid dup rows per FBref table (safeguard)
ps     AS (SELECT DISTINCT ON ("player_id") * FROM player_standard                      ORDER BY "player_id"),
pgk    AS (SELECT DISTINCT ON ("player_id") * FROM player_goalkeeping                  ORDER BY "player_id"),
p_shot AS (SELECT DISTINCT ON ("player_id") * FROM player_shooting                     ORDER BY "player_id"),
p_pass AS (SELECT DISTINCT ON ("player_id") * FROM player_passing                      ORDER BY "player_id"),
p_passt AS (SELECT DISTINCT ON ("player_id") * FROM "player_pass_types"                ORDER BY "player_id"),
p_gsc  AS (SELECT DISTINCT ON ("player_id") * FROM "player_goal_and_shot_creation"     ORDER BY "player_id"),
p_def  AS (SELECT DISTINCT ON ("player_id") * FROM player_defensive                    ORDER BY "player_id"),
p_poss AS (SELECT DISTINCT ON ("player_id") * FROM player_possession                   ORDER BY "player_id")

SELECT
  jsonb_strip_nulls(
    jsonb_build_object(
      'player_name',  t.player_name,
      'understat_team', t.team_title,
      'ids', jsonb_build_object(
        'canonical', x.canonical_player_id,
        'understat', t.understat_player_id,
        'fbref',     x.fbref_player_id
      ),
      'understat', to_jsonb(u.*),
      'fbref', jsonb_build_object(
        'standard',               to_jsonb(ps_row),
        'goalkeeping',            to_jsonb(pgk_row),
        'shooting',               to_jsonb(p_shot_row),
        'passing',                to_jsonb(p_pass_row),
        'pass_types',             to_jsonb(p_passt_row),
        'goal_and_shot_creation', to_jsonb(p_gsc_row),
        'defensive',              to_jsonb(p_def_row),
        'possession',             to_jsonb(p_poss_row)
      )
    )
  ) AS all_stats
FROM target t
JOIN players u ON u.id::text = t.understat_player_id
CROSS JOIN x
LEFT JOIN ps      ps_row      ON ps_row."player_id"::text  = x.fbref_player_id
LEFT JOIN pgk     pgk_row     ON pgk_row."player_id"::text = x.fbref_player_id
LEFT JOIN p_shot  p_shot_row  ON p_shot_row."player_id"::text = x.fbref_player_id
LEFT JOIN p_pass  p_pass_row  ON p_pass_row."player_id"::text = x.fbref_player_id
LEFT JOIN p_passt p_passt_row ON p_passt_row."player_id"::text = x.fbref_player_id
LEFT JOIN p_gsc   p_gsc_row   ON p_gsc_row."player_id"::text = x.fbref_player_id
LEFT JOIN p_def   p_def_row   ON p_def_row."player_id"::text = x.fbref_player_id
LEFT JOIN p_poss  p_poss_row  ON p_poss_row."player_id"::text = x.fbref_player_id;
$$;
"""

# ---------------------- SQL blocks (indexes) ----------------------

INDEX_STATEMENTS = (
    # Players / xref
    'CREATE INDEX IF NOT EXISTS idx_players_name_lower ON players (lower(player_name));',
    'CREATE INDEX IF NOT EXISTS idx_player_xref_understat ON player_xref(understat_player_id);',
    'CREATE INDEX IF NOT EXISTS idx_player_xref_fbref ON player_xref(fbref_player_id);',

    # FBref player tables by "player_id"
    'CREATE INDEX IF NOT EXISTS idx_fbref_std_pid   ON player_standard (("player_id"));',
    'CREATE INDEX IF NOT EXISTS idx_fbref_gk_pid    ON player_goalkeeping (("player_id"));',
    'CREATE INDEX IF NOT EXISTS idx_fbref_shot_pid  ON player_shooting (("player_id"));',
    'CREATE INDEX IF NOT EXISTS idx_fbref_pass_pid  ON player_passing (("player_id"));',
    'CREATE INDEX IF NOT EXISTS idx_fbref_passt_pid ON "player_pass_types" (("player_id"));',
    'CREATE INDEX IF NOT EXISTS idx_fbref_gsc_pid   ON "player_goal_and_shot_creation" (("player_id"));',
    'CREATE INDEX IF NOT EXISTS idx_fbref_def_pid   ON player_defensive (("player_id"));',
    'CREATE INDEX IF NOT EXISTS idx_fbref_poss_pid  ON player_possession (("player_id"));',
)
INDEX_STATEMENTS_CONCURRENTLY = tuple(
    s.replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX CONCURRENTLY IF NOT EXISTS")
    for s in INDEX_STATEMENTS
)

# ---------------------- Installers ----------------------

def install_fbref_sql(engine: Engine, schema: str = "public") -> None:

    with engine.begin() as conn:
        conn.exec_driver_sql(f"SET search_path TO {schema};")

        # 1) unaccent
        try:
            conn.exec_driver_sql(SQL_CREATE_UNACCENT)
        except Exception as e:
            raise RuntimeError(
                "Failed to create/verify 'unaccent' extension. Ensure it's available and permitted."
            ) from e

        # Smoke test
        try:
            conn.exec_driver_sql("SELECT unaccent('public.unaccent', 'école');")
        except Exception as e:
            raise RuntimeError(
                "The 'unaccent' extension exists but could not be invoked with dictionary 'public.unaccent'."
            ) from e

        # 2) imm_unaccent
        conn.exec_driver_sql(SQL_CREATE_IMM_UNACCENT)

        # 3) big JSON team functions
        conn.exec_driver_sql(SQL_CREATE_GET_FBREF_TEAM_JSON_ALL)
        conn.exec_driver_sql(SQL_CREATE_GET_FBREF_VS_TEAM_JSON_ALL)

        # 4) player aggregator
        conn.exec_driver_sql(SQL_CREATE_GET_PLAYER_ALL_STATS)


def create_indexes(engine: Engine, concurrently: bool = False, schema: str = "public") -> None:

    stmts: Iterable[str] = INDEX_STATEMENTS_CONCURRENTLY if concurrently else INDEX_STATEMENTS

    if concurrently:
        # Must run each statement outside an explicit transaction
        with engine.connect() as conn:
            conn.exec_driver_sql(f"SET search_path TO {schema};")
            for sql in stmts:
                conn.exec_driver_sql(sql)
    else:
        # Safe to run all in a single transaction (locks apply)
        with engine.begin() as conn:
            conn.exec_driver_sql(f"SET search_path TO {schema};")
            for sql in stmts:
                conn.exec_driver_sql(sql)

# ---------------------- Validators ----------------------

def validate_functions(engine: Engine) -> bool:

    qry = """
        SELECT COUNT(*) = 4 AS ok FROM (
          SELECT 'imm_unaccent' AS fn
          UNION ALL SELECT 'get_fbref_team_json_all'
          UNION ALL SELECT 'get_fbref_vs_team_json_all'
          UNION ALL SELECT 'get_player_all_stats'
        ) t
        JOIN pg_proc p ON p.proname = t.fn
        JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public';
    """
    with engine.begin() as conn:
        row = conn.exec_driver_sql(qry).one()
    return bool(row[0])


def install(engine):

    install_fbref_sql(engine)
    create_indexes(engine)
    print("Install complete. Functions OK:", validate_functions(engine))

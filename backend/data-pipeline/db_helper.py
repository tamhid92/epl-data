# postgres_helper.py
from __future__ import annotations

from io import StringIO
from typing import Dict, Iterable, List, Optional, Union

import pandas as pd
from sqlalchemy import (
    create_engine, MetaData, Table, Column, Index, text
)
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.types import (
    Integer, BigInteger, Float, Numeric, String, Text,
    Date, Time, DateTime, Boolean, JSON, UUID
)
from sqlalchemy.dialects.postgresql import insert as pg_insert
from typing import Any, Tuple

# Optional: only needed for COPY path
try:
    import psycopg2
except Exception:
    psycopg2 = None


_SQL_TYPE_MAP = {
    "int": Integer,
    "integer": Integer,
    "bigint": BigInteger,
    "float": Float,
    "numeric": Numeric,
    "decimal": Numeric,
    "text": Text,
    "string": String,        # alias
    "varchar": String,       # supports varchar(255) syntax via parse
    "date": Date,
    "time": Time,
    "timestamp": DateTime,
    "datetime": DateTime,    # alias
    "bool": Boolean,
    "boolean": Boolean,
    "json": JSON,
    "jsonb": JSON,           # JSON maps to JSONB on PG
    "uuid": UUID,
}

def _parse_type(type_str: str):
    """
    Map a friendly string like 'varchar(255)' or 'integer' to a SQLAlchemy type.
    Falls back to raw SQL if not recognized (advanced users can pass 'geometry', etc.).
    """
    ts = type_str.strip().lower()
    if ts.startswith("varchar(") and ts.endswith(")"):
        size = int(ts[8:-1])
        return String(length=size)
    base = ts.split("(", 1)[0]
    if base in _SQL_TYPE_MAP:
        # handle precision/scale for numeric(x,y)
        if base in ("numeric", "decimal") and "(" in ts and ts.endswith(")"):
            inside = ts[ts.find("(") + 1 : -1]
            parts = [p.strip() for p in inside.split(",")]
            if len(parts) == 2:
                return Numeric(precision=int(parts[0]), scale=int(parts[1]))
            elif len(parts) == 1:
                return Numeric(precision=int(parts[0]))
        return _SQL_TYPE_MAP[base]()
    # Unrecognized -> return raw type via text (usable in Column(type_=...))
    return text(type_str)


class Postgres:
    """
    Lightweight Postgres utility for table creation, bulk inserts, and UPSERTs.

    Example:
        db = Postgres("postgresql+psycopg2://user:pass@host:5432/dbname")

        # 1) Create table
        db.create_table(
            "fixtures",
            columns={
                "uid": "uuid",
                "date": "date",
                "home": "varchar(100)",
                "away": "varchar(100)",
                "venue": "text",
                "wk": "integer",
                "day": "varchar(10)",
                "time": "time"
            },
            primary_key=["uid"],
            uniques=[["date", "home", "away"]],
            indexes=[["home"], ["away"]],
            schema=None,  # or "public"
        )

        # 2) Insert a dataframe
        df = pd.DataFrame([...])
        db.insert_dataframe("fixtures", df)

        # 3) Upsert a dataframe on conflict keys
        db.upsert_dataframe("fixtures", df, conflict_columns=["uid"])
    """

    def __init__(self, url: str, *, echo: bool = False, future: bool = True):
        self.engine: Engine = create_engine(url, echo=echo, future=future)
        self.metadata = MetaData()

    # ---------- 1) CREATE TABLE ----------
    def create_table(
        self,
        table_name: str,
        *,
        columns: Dict[str, Union[str]],
        primary_key: Optional[Iterable[str]] = None,
        uniques: Optional[Iterable[Iterable[str]]] = None,
        indexes: Optional[Iterable[Iterable[str]]] = None,
        schema: Optional[str] = None,
        if_not_exists: bool = True,
    ):
        """
        Create a table with specified columns.

        columns: dict of column_name -> type string (e.g., "varchar(100)", "integer", "timestamp", "jsonb").
        primary_key: list of column names forming the primary key.
        uniques: list of unique constraint column lists, e.g., [["date","home","away"]]
        indexes: list of index column lists, e.g., [["home"],["away"]]
        """
        tbl = Table(
            table_name,
            self.metadata,
            *[
                Column(col, _parse_type(tp), nullable=False if primary_key and col in primary_key else True)
                for col, tp in columns.items()
            ],
            schema=schema
        )

        if primary_key:
            # If any PK column wasn’t marked as primary_key individually, set a composite PK:
            # SQLAlchemy needs PrimaryKeyConstraint for composite PK; simplest is to emit raw SQL.
            # To keep this simple and robust, we’ll add after create.
            pass

        # Create (if not exists)
        with self.engine.begin() as conn:
            # CREATE TABLE IF NOT EXISTS via SQL—works even for composite PK & unique constraints:
            cols_sql = []
            for col, tp in columns.items():
                cols_sql.append(f'"{col}" {tp}')
            constraints = []

            if primary_key:
                pk_cols = ", ".join(f'"{c}"' for c in primary_key)
                constraints.append(f"PRIMARY KEY ({pk_cols})")

            if uniques:
                for u in uniques:
                    uq_cols = ", ".join(f'"{c}"' for c in u)
                    constraints.append(f"UNIQUE ({uq_cols})")

            cols_clause = ", ".join(cols_sql + constraints)
            if schema:
                fqtn = f'"{schema}"."{table_name}"'
            else:
                fqtn = f'"{table_name}"'
            ine = "IF NOT EXISTS " if if_not_exists else ""
            create_sql = f'CREATE TABLE {ine}{fqtn} ({cols_clause});'
            conn.exec_driver_sql(create_sql)

            # Indexes
            if indexes:
                for ix_cols in indexes:
                    ix_name = f'ix_{table_name}_' + "_".join(ix_cols)
                    cols = ", ".join(f'"{c}"' for c in ix_cols)
                    create_idx = f'CREATE INDEX IF NOT EXISTS "{ix_name}" ON {fqtn} ({cols});'
                    conn.exec_driver_sql(create_idx)

    # ---------- 2) INSERT DATAFRAME ----------
    def insert_dataframe(
        self,
        table_name: str,
        df: pd.DataFrame,
        *,
        schema: Optional[str] = None,
        use_copy: bool = True,
        chunksize: int = 50_000,
    ):
        """
        Fast bulk insert of a DataFrame.

        - Tries PostgreSQL COPY for speed (requires psycopg2).
        - Falls back to pandas.to_sql if COPY is unavailable.
        """
        if df.empty:
            return

        fqtn = f'"{schema}"."{table_name}"' if schema else f'"{table_name}"'

        if use_copy and psycopg2 is not None:
            raw = self.engine.raw_connection()
            try:
                with raw.cursor() as cur:
                    buf = StringIO()
                    # Write CSV without header; ensure NaN -> \N for NULL
                    df.to_csv(buf, index=False, header=False, na_rep="\\N")
                    buf.seek(0)
                    cols = ", ".join(f'"{c}"' for c in df.columns)
                    cur.copy_expert(
                        sql=f'COPY {fqtn} ({cols}) FROM STDIN WITH (FORMAT CSV, NULL \'\\N\')',
                        file=buf
                    )
                raw.commit()
            except Exception:
                raw.rollback()
                raise
            finally:
                raw.close()
        else:
            # Fallback: pandas (uses SQLAlchemy executemany)
            df.to_sql(
                name=table_name,
                con=self.engine,
                schema=schema,
                if_exists="append",
                index=False,
                chunksize=chunksize,
                method="multi",
            )

    # ---------- 3) UPSERT DATAFRAME ----------
    def upsert_dataframe(
        self,
        table_name: str,
        df: pd.DataFrame,
        *,
        conflict_columns: List[str],
        update_columns: Optional[List[str]] = None,
        schema: Optional[str] = None,
        chunksize: int = 20_000,
    ):
        """
        Upsert a DataFrame using PostgreSQL ON CONFLICT DO UPDATE.

        conflict_columns: columns that define the unique/PK constraint (must exist as a real constraint/index).
        update_columns: columns to update on conflict; defaults to all df columns except conflict columns.

        Notes:
        - Requires the target table to exist and have a UNIQUE/PRIMARY KEY on conflict_columns.
        - Automatically chunks large frames.
        """
        if df.empty:
            return

        metadata = MetaData(schema=schema)
        table = Table(table_name, metadata, autoload_with=self.engine)

        if update_columns is None:
            update_columns = [c for c in df.columns if c not in set(conflict_columns)]

        records = df.to_dict(orient="records")

        def _do_chunk(chunk):
            stmt = pg_insert(table).values(chunk)
            set_dict = {col: stmt.excluded[col] for col in update_columns}
            stmt = stmt.on_conflict_do_update(
                index_elements=conflict_columns,
                set_=set_dict
            )
            with self.engine.begin() as conn:
                conn.execute(stmt)

        if len(records) <= chunksize:
            _do_chunk(records)
        else:
            for i in range(0, len(records), chunksize):
                _do_chunk(records[i : i + chunksize])

    def insert_dict(
        self,
        table_name: str,
        data: Union[Dict, List[Dict]],
        *,
        schema: Optional[str] = None
    ):
        """
        Insert a single dict or list of dicts into a table.

        Example:
            db.insert_dict("teams", {"id": 1, "name": "Arsenal"})
            db.insert_dict("teams", [{"id": 2, "name": "Liverpool"}, {"id": 3, "name": "Chelsea"}])
        """
        if isinstance(data, dict):
            data = [data]  # make it a list of one

        if not data:
            return  # nothing to insert

        metadata = MetaData(schema=schema)
        table = Table(table_name, metadata, autoload_with=self.engine)

        with self.engine.begin() as conn:
            conn.execute(table.insert(), data)
    
    def drop_table(
        self,
        table_name: str,
        *,
        schema: Optional[str] = None,
        if_exists: bool = True,
        cascade: bool = False,
    ):
        """
        Drop a table from the database.

        Args:
            table_name: Name of the table.
            schema: Optional schema (defaults to search_path if None).
            if_exists: If True, add IF EXISTS clause.
            cascade: If True, add CASCADE (drops dependent objects).
        """
        fqtn = f'"{schema}"."{table_name}"' if schema else f'"{table_name}"'
        ie = "IF EXISTS " if if_exists else ""
        csc = " CASCADE" if cascade else ""
        sql = f'DROP TABLE {ie}{fqtn}{csc};'

        with self.engine.begin() as conn:
            conn.exec_driver_sql(sql)

    def create_table_v2(
        self,
        table_name: str,
        *,
        columns: dict[str, str],
        primary_key: list[str] | None = None,
        uniques: list[list[str]] | None = None,
        indexes: list[list[str]] | None = None,
        schema: str | None = None,
        if_not_exists: bool = True,
    ):
        def q(name: str) -> str:
            return '"' + name.replace('"', '""') + '"'

        def norm_type(tp: str) -> str:
            tl = tp.strip().lower()
            if tl == "decimal":
                return "NUMERIC"
            if tl == "string":
                return "TEXT"
            return tp

        fqtn = f'{q(schema)}.{q(table_name)}' if schema else q(table_name)

        cols_sql = [f"{q(col)} {norm_type(tp)}" for col, tp in columns.items()]
        constraints = []
        if primary_key:
            constraints.append(f"PRIMARY KEY ({', '.join(q(c) for c in primary_key)})")
        if uniques:
            for u in uniques:
                constraints.append(f"UNIQUE ({', '.join(q(c) for c in u)})")

        ine = "IF NOT EXISTS " if if_not_exists else ""
        create_sql = f"CREATE TABLE {ine}{fqtn} ({', '.join(cols_sql + constraints)});"

        # index name sanitizer (identifiers only; columns remain quoted)
        def safe_ix_name(cols: list[str]) -> str:
            core = "_".join("".join(ch if (ch.isalnum() or ch == "_") else "_" for ch in c) for c in cols)
            return (f"ix_{table_name}_{core}")[:63]

        # --- Pure DBAPI path ---
        conn = self.engine.raw_connection()   # bypass SA DDL/compiler layers
        try:
            with conn.cursor() as cur:
                # helpful debug:
                # print("DDL =>", create_sql)
                cur.execute(create_sql)
                if indexes:
                    for ix_cols in indexes:
                        ix_name = safe_ix_name(ix_cols)
                        cur.execute(
                            f'CREATE INDEX IF NOT EXISTS {q(ix_name)} ON {fqtn} ({", ".join(q(c) for c in ix_cols)});'
                        )
            conn.commit()
        finally:
            conn.close()

        # ---------- 4) RUN ARBITRARY SQL QUERIES ----------
    def query_df(
        self,
        sql: str,
        params: Optional[Union[Dict[str, Any], Tuple[Any, ...]]] = None,
    ) -> pd.DataFrame:
        """
        Execute a SQL query and return a pandas DataFrame.

        Params style:
          - Positional: use %s placeholders and pass a tuple, e.g. ("Arsenal",)
          - Named: use %(name)s placeholders and pass a dict, e.g. {"team": "Arsenal"}

        Examples:
            df = db.query_df("SELECT * FROM fixtures WHERE home = %s", ("Arsenal",))
            df = db.query_df("SELECT * FROM fixtures WHERE home = %(team)s", {"team": "Arsenal"})
        """
        with self.engine.begin() as conn:
            cur = conn.exec_driver_sql(sql, params or {})
            if not cur.returns_rows:
                # Non-SELECT; nothing to return as DataFrame
                return pd.DataFrame()
            # Use mappings() to get dict-like rows; this preserves column names cleanly
            rows = cur.mappings().all()
            return pd.DataFrame(rows)

    def query_all(
        self,
        sql: str,
        params: Optional[Union[Dict[str, Any], Tuple[Any, ...]]] = None,
    ) -> List[Dict[str, Any]]:
        """
        Execute a SQL query and return a list of dict rows.

        Useful when you want plain Python objects instead of a DataFrame.
        """
        with self.engine.begin() as conn:
            cur = conn.exec_driver_sql(sql, params or {})
            if not cur.returns_rows:
                return []
            return [dict(r) for r in cur.mappings().all()]

    def query_one(
        self,
        sql: str,
        params: Optional[Union[Dict[str, Any], Tuple[Any, ...]]] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Execute a SQL query and return a single row as a dict (or None if no rows).
        """
        with self.engine.begin() as conn:
            cur = conn.exec_driver_sql(sql, params or {})
            if not cur.returns_rows:
                return None
            row = cur.mappings().first()
            return dict(row) if row is not None else None

    def execute(
        self,
        sql: str,
        params: Optional[Union[Dict[str, Any], Tuple[Any, ...]]] = None,
    ) -> int:
        """
        Execute a non-SELECT statement (INSERT/UPDATE/DELETE/DDL).
        Returns the rowcount when available (may be -1 depending on driver/statement).

        Example:
            affected = db.execute(
                "UPDATE fixtures SET venue = %s WHERE id = %s",
                ("Old Trafford", 12345),
            )
        """
        with self.engine.begin() as conn:
            cur = conn.exec_driver_sql(sql, params or {})
            return cur.rowcount if hasattr(cur, "rowcount") else -1

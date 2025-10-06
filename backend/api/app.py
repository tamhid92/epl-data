import os
import logging
import json
import re
import time
from datetime import date, datetime, time as dtime, timezone
from decimal import Decimal
from uuid import UUID
import threading
from time import sleep
from collections import defaultdict
from typing import Any, Dict, Iterable, List, Optional, Tuple
from flask import Flask, jsonify, request, abort, g, Response
from flask_cors import CORS
import psycopg2
from psycopg2.extras import RealDictCursor
from psycopg2.pool import SimpleConnectionPool
from typing import Optional
from ua_parser import user_agent_parser
from user_agents import parse as ua_parse
import ipaddress
import requests
from functools import lru_cache

# -------------------- Prometheus --------------------
from prometheus_client import (
    Counter, Histogram, Gauge, generate_latest, CONTENT_TYPE_LATEST,
    CollectorRegistry, multiprocess, PROCESS_COLLECTOR, PLATFORM_COLLECTOR
)

# -------------------- Config --------------------
API_TOKEN = os.getenv("API_TOKEN", "").strip()
DB_HOST = os.getenv("DB_HOST", "postgres")
DB_PORT = int(os.getenv("DB_PORT", "5432"))
DB_NAME = os.getenv("DB_NAME", "epl")
DB_USER = os.getenv("DB_USER")
DB_PASS = os.getenv("DB_PASS", "")

GEO_URL = os.getenv("GEO_URL", "http://ipgeo.epl-data.svc.cluster.local:8080")
GEO_TIMEOUT = float(os.getenv("GEO_TIMEOUT", "0.35"))     # seconds
GEO_CACHE_TTL = int(os.getenv("GEO_CACHE_TTL", "1800"))   # seconds (30m)

POOL: Optional[SimpleConnectionPool] = None
POOL_LOCK = threading.Lock()


POOL_MIN = int(os.getenv("DB_POOL_MIN", "1"))
POOL_MAX = int(os.getenv("DB_POOL_MAX", "10"))

CORS_ENABLED = os.getenv("CORS_ENABLED", "false").lower() == "true"
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "").split(",") if os.getenv("CORS_ORIGINS") else []

ALLOWED_TEAM_TABLES = ["team_chances_created","team_chances_conceded","formations","shot_zone","shot_zone_conceded","timing","timing_conceded", "players"]

IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")

MAX_LIMIT = int(os.getenv("MAX_PAGE_LIMIT", "1000"))
DEFAULT_LIMIT = int(os.getenv("DEFAULT_PAGE_LIMIT", "200"))

# Logging
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
LOG_JSON  = os.getenv("LOG_JSON", "true").lower() == "true"

# Prometheus multiprocess (Gunicorn) support
PROM_MULTI_DIR = os.getenv("PROMETHEUS_MULTIPROC_DIR")  # set in k8s
if PROM_MULTI_DIR:
    registry = CollectorRegistry()
    multiprocess.MultiProcessCollector(registry)
else:
    registry = CollectorRegistry()

PUBLIC_PATHS = {
    "/health",
    "/readyz",
    "/metrics",
}

# -------------------- App --------------------
app = Flask(__name__)
app.url_map.strict_slashes = False
if CORS_ENABLED:
    CORS(app, resources={r"/*": {"origins": CORS_ORIGINS}})

# -------------------- Structured logging --------------------
class JsonFormatter(logging.Formatter):
    def format(self, record):
        payload = {
            "ts": datetime.utcnow().isoformat() + "Z",
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        # Attach request context if present
        rid = getattr(g, "request_id", None)
        if rid:
            payload["request_id"] = rid
        path = getattr(g, "request_path", None)
        if path:
            payload["path"] = path
        method = getattr(g, "request_method", None)
        if method:
            payload["method"] = method
        status = getattr(g, "response_status", None)
        if status is not None:
            payload["status"] = status
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)

def _setup_logging():
    gunicorn_logger = logging.getLogger("gunicorn.error")
    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)
    handler = logging.StreamHandler()
    if LOG_JSON:
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root.addHandler(handler)
    root.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))
    if gunicorn_logger and gunicorn_logger.handlers:
        root.handlers = gunicorn_logger.handlers
        root.setLevel(gunicorn_logger.level)

_setup_logging()
logger = logging.getLogger(__name__)

def _is_public(path: str) -> bool:
    return path in PUBLIC_PATHS

def _device_family(ua_str: str) -> str:
    ua = ua_parse(ua_str or "")
    if ua.is_bot:    return "Bot"
    if ua.is_mobile: return "Mobile"
    if ua.is_tablet: return "Tablet"
    if ua.is_pc:     return "Desktop"
    return "Other"

def _parse_ua(ua_str: str):
    p = user_agent_parser.Parse(ua_str or "")
    browser = (p["user_agent"]["family"] or "unknown").lower()
    browser_major = p["user_agent"]["major"] or "0"
    os_fam = (p["os"]["family"] or "unknown").lower()
    os_major = p["os"]["major"] or "0"
    dev = _device_family(ua_str or "")
    return dev, os_fam, os_major, browser, browser_major

_geo_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}
def _geo_cache_get(ip: str) -> Optional[Dict[str, Any]]:
    now = time.time()
    ent = _geo_cache.get(ip)
    if not ent: return None
    ts, val = ent
    if now - ts > GEO_CACHE_TTL:
        _geo_cache.pop(ip, None)
        return None
    return val

def _geo_cache_put(ip: str, val: Dict[str, Any]) -> None:
    _geo_cache[ip] = (time.time(), val)

def _is_public_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
        return not (addr.is_private or addr.is_loopback or addr.is_reserved or addr.is_link_local)
    except Exception:
        return False

def _geo_lookup(ip: str) -> Dict[str, Any]:
    """
    Returns a dict with keys:
    country_iso2, country_name, region, city, latitude, longitude, asn, isp
    Falls back to empty/unknown fields on error. Never raises.
    """
    # Cache first
    if not ip or not _is_public_ip(ip):
        return {}
    hit = _geo_cache_get(ip)
    if hit is not None:
        return hit

    try:
        r = requests.get(f"{GEO_URL}/lookup", params={"ip": ip}, timeout=GEO_TIMEOUT)
        if r.ok:
            data = r.json() or {}
            # normalize fields
            out = {
                "country_iso2": (data.get("country_iso2") or data.get("country_code") or "").upper(),
                "country_name": data.get("country_name") or "",
                "region":       data.get("region") or data.get("region_name") or "",
                "city":         data.get("city") or "",
                "latitude":     data.get("latitude"),
                "longitude":    data.get("longitude"),
                "asn":          data.get("asn") or data.get("as") or "",
                "isp":          data.get("isp") or data.get("org") or "",
            }
            _geo_cache_put(ip, out)
            return out
    except Exception:
        pass

    return {}



# -------------------- Security headers --------------------
@app.after_request
def add_security_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Cache-Control"] = "no-store"
    return resp

# -------------------- Prometheus metrics --------------------
REQUESTS = Counter(
    "api_requests_total",
    "Total HTTP requests",
    ["method", "endpoint", "status"],
    registry=registry,
)
REQ_LATENCY = Histogram(
    "api_request_duration_seconds",
    "Request latency in seconds",
    ["method", "endpoint"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10),
    registry=registry,
)
INFLIGHT = Gauge(
    "api_inflight_requests",
    "In-flight requests",
    registry=registry,
)

REBUILD_COUNT = Counter(
    "weekly_table_rebuild_total",
    "Weekly table rebuilds",
    ["result"],  # success|error
    registry=registry,
)
REBUILD_DURATION = Histogram(
    "weekly_table_rebuild_duration_seconds",
    "Duration of weekly table rebuilds",
    registry=registry,
)

DB_POOL_AVAILABLE = Gauge(
    "db_pool_available_connections",
    "Connections currently available in pool",
    registry=registry,
)
DB_POOL_INUSE = Gauge(
    "db_pool_inuse_connections",
    "Connections currently in use",
    registry=registry,
)
VISITS_TOTAL = Counter(
    "web_visits_total",
    "Total visits (all API hits counted)",
    registry=registry,
)

VISITS_BY_COUNTRY = Counter(
    "web_visits_by_country_total",
    "Visits by country (from Cloudflare header if available)",
    ["country"],
    registry=registry,
)

VISITS_BY_UA = Counter(
    "web_visits_by_ua_total",
    "Visits by coarse UA buckets",
    ["device", "os", "os_major", "browser", "browser_major"],
    registry=registry,
)

def _endpoint_label():
    # use rule endpoint if available; fallback to path
    if request.url_rule and request.url_rule.rule:
        return request.url_rule.rule
    return request.path or "unknown"

@app.before_request
def _api_token_gate():
    # Let probes/metrics through, and keep OPTIONS preflights harmless.
    if request.method == "OPTIONS" or _is_public(request.path):
        return

    # Expect token in header (preferred). Optional: allow ?api_token=... for quick tests.
    token = request.headers.get("X-API-Token") or request.args.get("api_token")
    if not API_TOKEN or token != API_TOKEN:
        abort(401, description="Missing or Invalid API token")


@app.before_request
def _start_timer_and_request_id():
    g.start_time = time.time()
    g.request_id = request.headers.get("X-Request-ID") or request.headers.get("X-Cf-Ray") or os.urandom(6).hex()
    g.request_path = request.path
    g.request_method = request.method
    INFLIGHT.inc()

@app.before_request
def _visit_enrich_and_count():
    # Only if request made it past the token gate (public paths are fine too)
    try:
        # Real client IP & country via Cloudflare; safe fallbacks otherwise
        client_ip = request.headers.get("CF-Connecting-IP") \
                    or request.headers.get("X-Forwarded-For","").split(",")[0].strip() \
                    or request.remote_addr

        # Prefer Cloudflare’s country for speed; we’ll still enrich from local geo for city/ASN/etc
        cf_country = (request.headers.get("CF-IPCountry") or "").strip().upper()
        geo = _geo_lookup(client_ip) if _is_public_ip(client_ip) else {}

        # Choose ISO2 country code: geo > CF > UNKNOWN
        country = (geo.get("country_iso2") or cf_country or "UNKNOWN").upper()

        ua_str = request.headers.get("User-Agent","")
        dev, os_fam, os_major, browser, browser_major = _parse_ua(ua_str)

        # stash for logging after response
        g._visit = {
            "ts": int(time.time()),
            "path": request.path,
            "method": request.method,
            "ip": client_ip,
            "country": country,
            "city": geo.get("city") or "",
            "region": geo.get("region") or "",
            "asn": geo.get("asn") or "",
            "isp": geo.get("isp") or "",
            "lat": geo.get("latitude"),
            "lon": geo.get("longitude"),
            "device": dev,
            "os": f"{os_fam} {os_major}",
            "browser": f"{browser} {browser_major}",
        }

        # Prometheus counters (NO IPs in labels!)
        VISITS_TOTAL.inc()
        if country != "UNKNOWN":
            VISITS_BY_COUNTRY.labels(country=country).inc()
        VISITS_BY_UA.labels(
            device=dev, os=os_fam, os_major=os_major,
            browser=browser, browser_major=browser_major
        ).inc()

    except Exception:
        # never block requests due to telemetry
        pass


@app.after_request
def _record_metrics_and_log(resp):
    try:
        duration = max(time.time() - getattr(g, "start_time", time.time()), 0)
        endpoint = _endpoint_label()
        REQ_LATENCY.labels(request.method, endpoint).observe(duration)
        REQUESTS.labels(request.method, endpoint, str(resp.status_code)).inc()
        g.response_status = resp.status_code
        # basic access log
        logger.info(f"{request.method} {request.path} -> {resp.status_code} in {duration:.4f}s")
    finally:
        INFLIGHT.dec()
    # propagate request id
    resp.headers["X-Request-ID"] = g.request_id
    try:
        v = getattr(g, "_visit", None)
        if v:
            v = dict(v)  # copy
            v["status"] = resp.status_code
            v["event"] = "visit"
            # Emit a clean JSON line alongside your structured logs.
            # (We keep IP only in logs; never in Prometheus labels.)
            print(json.dumps(v, ensure_ascii=False), flush=True)
    except Exception:
        pass
    return resp

@app.route("/metrics")
def metrics():
    # for multiprocess, must use the configured registry
    return Response(generate_latest(registry), mimetype=CONTENT_TYPE_LATEST)

# -------------------- DB Pool --------------------
def _export_pool_metrics():
    # not exact, but good visibility
    try:
        DB_POOL_AVAILABLE.set(POOL._pool.qsize())
        if POOL is None:
            DB_POOL_AVAILABLE.set(0)
            DB_POOL_INUSE.set(0)
            return
        DB_POOL_AVAILABLE.set(POOL._pool.qsize())
        # in-use = maxconn - available (approx; psycopg2 SimpleConnectionPool has _pool and _used)
        inuse = len(getattr(POOL, "_used", {}))
        DB_POOL_INUSE.set(inuse)
    except Exception:
        pass

def _ensure_pool():
    """Initialize the pool once with small retry/backoff."""
    global POOL
    if POOL is not None:
        return
    with POOL_LOCK:
        if POOL is not None:
            return
        for attempt in range(1, 31):  # ~60s total
            try:
                p = SimpleConnectionPool(
                    POOL_MIN,
                    POOL_MAX,
                    host=DB_HOST,
                    port=DB_PORT,
                    dbname=DB_NAME,
                    user=DB_USER,
                    password=DB_PASS,
                    connect_timeout=5,
                    application_name="epl_api",
                )
                # quick sanity check
                with p.getconn() as c:
                    with c.cursor() as cur:
                        cur.execute("SELECT 1;")
                POOL = p
                logger.info("DB pool initialized")
                _export_pool_metrics()
                return
            except Exception as e:
                logger.warning("DB pool init attempt %d/30 failed: %s", attempt, e)
                time.sleep(2)
        logger.error("DB pool could not be initialized after retries")

class ConnCtx:
    def __enter__(self):
        _ensure_pool()
        if POOL is None:
            # readiness will fail with 503; liveness (/health) stays OK
            raise RuntimeError("DB unavailable")
        self.conn = POOL.getconn()
        _export_pool_metrics()
        return self.conn

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc:
                self.conn.rollback()
            else:
                self.conn.commit()
        finally:
            POOL.putconn(self.conn)
            _export_pool_metrics()

def _to_jsonable(v):
    if isinstance(v, (datetime, date, dtime)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, UUID):
        return str(v)
    return v

def jsonify_records(records):
    return jsonify([{k: _to_jsonable(v) for k, v in rec.items()} for rec in records])

def _pagination():
    try:
        limit = int(request.args.get("limit", DEFAULT_LIMIT))
        offset = int(request.args.get("offset", 0))
    except ValueError:
        abort(400, description="limit and offset must be integers")
    limit = max(1, min(limit, MAX_LIMIT))
    offset = max(0, offset)
    return limit, offset

def _safe_ident(name: str) -> str:
    if not name or not IDENTIFIER_RE.match(name):
        abort(400, description="Invalid identifier")
    return name

def _check_team_table(name: str) -> str:
    name = _safe_ident(name)
    if name not in ALLOWED_TEAM_TABLES:
        abort(404, description=f"Unknown table '{name}'")
    return name

# -------------------- Weekly Table (single league/season) --------------------
WEEKLY_TABLE: Dict[str, Any] = {}
WEEKLY_TABLE_LAST_BUILT: Optional[datetime] = None
WEEKLY_TABLE_LOCK = threading.Lock()
WEEKLY_REFRESH_INTERVAL_SECONDS = 7 * 24 * 60 * 60  # once a week

def _to_int(v: Any, default: Optional[int] = 0) -> int:
    try:
        return int(v)
    except Exception:
        try:
            return int(float(v))
        except Exception:
            return default if default is not None else 0

def _parse_dt(s: Any) -> datetime:
    if isinstance(s, datetime):
        return s
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return datetime.min.replace(year=1)

def _build_weekly_table_from_rows(rows: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    rows = list(rows)
    if not rows:
        return {"weeks": [], "teams": [], "long": []}

    rows.sort(key=lambda r: (_parse_dt(r.get("date_utc")), _to_int(r.get("match_id"), 0)))

    teams = sorted({str(r["team_h"]) for r in rows} | {str(r["team_a"]) for r in rows})
    contrib: Dict[str, List[Dict[str, int]]] = {t: [] for t in teams}

    def add_game(home: str, away: str, hg: int, ag: int):
        if hg > ag:
            hpts, apts = 3, 0
        elif hg < ag:
            hpts, apts = 0, 3
        else:
            hpts, apts = 1, 1
        contrib[home].append({"pts": hpts, "gf": hg, "ga": ag})
        contrib[away].append({"pts": apts, "gf": ag, "ga": hg})

    for r in rows:
        add_game(str(r["team_h"]), str(r["team_a"]), _to_int(r["home_goals"], 0), _to_int(r["away_goals"], 0))

    counts = [len(contrib[t]) for t in teams]
    if not counts:
        return {"weeks": [], "teams": [], "long": []}
    R = min(counts)
    if R <= 0:
        return {"weeks": [], "teams": [{"team": t, "pos": []} for t in teams], "long": []}

    def rank(agg: Dict[str, Dict[str, int]]) -> List[str]:
        def key_fn(t: str) -> Tuple[int, int, int, str]:
            pts = agg[t]["pts"]; gd = agg[t]["gf"] - agg[t]["ga"]; gf = agg[t]["gf"]
            return (-pts, -gd, -gf, t)
        return sorted(teams, key=key_fn)

    positions_by_team = {t: [] for t in teams}
    long_rows: List[Dict[str, Any]] = []

    for k in range(1, R + 1):
        totals = {t: {"pts": sum(x["pts"] for x in contrib[t][:k]),
                      "gf": sum(x["gf"] for x in contrib[t][:k]),
                      "ga": sum(x["ga"] for x in contrib[t][:k])} for t in teams}
        order = rank(totals)
        pos = {t: i + 1 for i, t in enumerate(order)}
        for t in teams:
            positions_by_team[t].append(pos[t])
            long_rows.append({"team": t, "week": k, "pos": pos[t]})

    return {"weeks": list(range(1, R + 1)),
            "teams": [{"team": t, "pos": positions_by_team[t]} for t in teams],
            "long": long_rows}

def rebuild_weekly_table() -> Dict[str, Any]:
    logger.info("Rebuilding weekly table from match_info …")
    start = time.time()
    try:
        with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT match_id, date_utc, team_h, team_a, home_goals, away_goals
                FROM match_info
                ORDER BY date_utc ASC, match_id ASC
            """)
            all_rows = cur.fetchall()

        data = _build_weekly_table_from_rows(all_rows)
        with WEEKLY_TABLE_LOCK:
            WEEKLY_TABLE.clear()
            WEEKLY_TABLE.update(data)
            global WEEKLY_TABLE_LAST_BUILT
            WEEKLY_TABLE_LAST_BUILT = datetime.now(timezone.utc)

        REBUILD_COUNT.labels("success").inc()
        duration = time.time() - start
        REBUILD_DURATION.observe(duration)
        logger.info(f"Weekly table built: weeks={len(data.get('weeks', []))} teams={len(data.get('teams', []))} in {duration:.3f}s")
        return {
            "weeks": len(data.get("weeks", [])),
            "teams": len(data.get("teams", [])),
            "last_built": WEEKLY_TABLE_LAST_BUILT.isoformat() if WEEKLY_TABLE_LAST_BUILT else None
        }
    except Exception:
        REBUILD_COUNT.labels("error").inc()
        REBUILD_DURATION.observe(time.time() - start)
        logger.exception("Weekly table rebuild failed")
        raise

def _weekly_refresh_loop():
    while True:
        try:
            sleep(WEEKLY_REFRESH_INTERVAL_SECONDS)
            rebuild_weekly_table()
        except Exception:
            logger.exception("Weekly refresh loop failed; will retry after interval")

# -------------------- Health --------------------
@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})

@app.route("/readyz", methods=["GET"])
def readyz():
    try:
        with ConnCtx() as conn, conn.cursor() as cur:
            cur.execute("SELECT 1;")
            _ = cur.fetchone()
        return jsonify({"ready": True})
    except Exception:
        logger.exception("Readiness check failed")
        abort(503, description="DB not ready")

# -------------------- Routes --------------------
@app.route("/<string:team>/squad", methods=["GET"])
def squad(team):
    limit, offset = _pagination()
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""SELECT * FROM players WHERE "team_title" = %s ORDER BY id ASC LIMIT %s OFFSET %s""",
                    (team, limit, offset))
        return jsonify_records(cur.fetchall())

@app.route("/standings", methods=["GET"])
def standings():
    limit, offset = _pagination()
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT * FROM standings LIMIT %s OFFSET %s', (limit, offset))
        return jsonify_records(cur.fetchall())

@app.route("/standings/<string:team>", methods=["GET"])
def standings_team(team):
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT * FROM standings WHERE "Team" = %s', (team,))
        return jsonify_records(cur.fetchall())

@app.route("/teams/names", methods=["GET"])
def get_team_names():
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT team_name FROM epl_teams ORDER BY team_name ASC;')
        return jsonify_records(cur.fetchall())

@app.route("/teams", methods=["GET"])
def epl_teams():
    limit, offset = _pagination()
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT * FROM epl_teams ORDER BY team_name ASC LIMIT %s OFFSET %s;', (limit, offset))
        return jsonify_records(cur.fetchall())

@app.route("/chances_created/<string:team>", methods=["GET"])
def chance_created(team):
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT * FROM team_chances_created WHERE "team_name" = %s', (team,))
        return jsonify_records(cur.fetchall())

@app.route("/chances_conceded/<string:team>", methods=["GET"])
def chance_conceded(team):
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT * FROM team_chances_conceded WHERE "team_name" = %s', (team,))
        return jsonify_records(cur.fetchall())

@app.route("/formation/<string:team>", methods=["GET"])
def team_formation(team):
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT * FROM formations WHERE "team_name" = %s', (team,))
        return jsonify_records(cur.fetchall())

@app.route("/fixtures", methods=["GET"])
def fixtures():
    limit, offset = _pagination()
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT * FROM fixtures ORDER BY id ASC LIMIT %s OFFSET %s;', (limit, offset))
        return jsonify_records(cur.fetchall())

@app.route("/fixtures/<string:match_id>", methods=["GET"])
def fixtures_match_id(match_id):
    limit, offset = _pagination()
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT * FROM fixtures WHERE id = %s LIMIT %s OFFSET %s;', (match_id, limit, offset))
        return jsonify_records(cur.fetchall())

@app.route("/fixtures/upcoming", methods=["GET"])
def upcoming_fixtures():
    limit, offset = _pagination()
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('''SELECT * FROM fixtures WHERE "isResult" IS NOT TRUE ORDER BY id ASC LIMIT %s OFFSET %s''',
                    (limit, offset))
        return jsonify_records(cur.fetchall())

@app.route("/fixtures/upcoming/<string:team>", methods=["GET"])
def upcoming_team_fixtures(team):
    limit, offset = _pagination()
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('''
            SELECT * FROM fixtures
            WHERE "isResult" IS NOT TRUE
              AND ("home_team" = %s OR "away_team" = %s)
            ORDER BY id ASC
            LIMIT %s OFFSET %s
        ''', (team, team, limit, offset))
        return jsonify_records(cur.fetchall())

@app.route("/fixtures/<string:team>", methods=["GET"])
def team_fixtures(team):
    limit, offset = _pagination()
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            'SELECT * FROM fixtures WHERE "home_team" = %s OR "away_team" = %s ORDER BY id ASC LIMIT %s OFFSET %s;',
            (team, team, limit, offset),
        )
        return jsonify_records(cur.fetchall())

@app.route("/recents", methods=["GET"])
def recent_results():
    limit, offset = _pagination()
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('''
            SELECT * FROM fixtures WHERE "isResult" IS TRUE ORDER BY id DESC LIMIT %s OFFSET %s
        ''', (limit, offset))
        return jsonify_records(cur.fetchall())

@app.route("/recents/<string:team>", methods=["GET"])
def recent_results_team(team):
    limit, offset = _pagination()
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('''
            SELECT * FROM fixtures
            WHERE "isResult" IS TRUE
              AND ("home_team" = %s OR "away_team" = %s)
            ORDER BY id DESC
            LIMIT %s OFFSET %s
        ''', (team, team, limit, offset))
        return jsonify_records(cur.fetchall())

@app.route("/players/<string:team>", methods=["GET"])
def players(team):
    limit, offset = _pagination()
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT * FROM players WHERE "team_title" = %s ORDER BY id ASC LIMIT %s OFFSET %s',
                    (team, limit, offset))
        return jsonify_records(cur.fetchall())

@app.route("/match/shots/<string:match_id>", methods=["GET"])
def shot_data(match_id):
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT * FROM shots_data WHERE "match_id" = %s', (match_id,))
        return jsonify_records(cur.fetchall())

@app.route("/shots/<string:team>", methods=["GET"])
def shot_data_team(team):
    # ⚠️ safer than the previous f-string
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('''
            SELECT * FROM shots_data
            WHERE (home_team = %s AND team_side = 'h')
               OR (away_team = %s AND team_side = 'a')
        ''', (team, team))
        return jsonify_records(cur.fetchall())

@app.route("/match/info/<string:match_id>", methods=["GET"])
def match_info(match_id):
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT * FROM match_info WHERE "match_id" = %s', (match_id,))
        return jsonify_records(cur.fetchall())

@app.route("/match/roster/<string:match_id>", methods=["GET"])
def match_rosters_data(match_id):
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('SELECT * FROM match_rosters_data WHERE "match_id" = %s', (match_id,))
        return jsonify_records(cur.fetchall())

@app.route("/weekly_table", methods=["GET"])
def weekly_table_get():
    with WEEKLY_TABLE_LOCK:
        if not WEEKLY_TABLE:
            abort(404, description="Weekly table not available. Try rebuilding.")
        payload = {
            "last_built": WEEKLY_TABLE_LAST_BUILT.isoformat() if WEEKLY_TABLE_LAST_BUILT else None,
            "data": WEEKLY_TABLE,
        }
    return jsonify(payload)

@app.route("/admin/rebuild_weekly_table", methods=["POST"])
def weekly_table_rebuild():
    try:
        info = rebuild_weekly_table()
        return jsonify({"ok": True, **info})
    except Exception:
        logger.exception("Manual weekly table rebuild failed")
        abort(503, description="Rebuild failed")

@app.route("/<string:team_stat>/<string:team>", methods=["GET"])
def ind_team_data(team_stat, team):
    table = _check_team_table(team_stat)
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(f'SELECT * FROM {table} WHERE "team_name" = %s', (team,))
        return jsonify_records(cur.fetchall())

@app.route("/<string:team_stat>/conceded/<string:team>", methods=["GET"])
def ind_team_data_conceded(team_stat, team):
    table = _check_team_table(f"{team_stat}_conceded")
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(f'SELECT * FROM {table} WHERE "team_name" = %s', (team,))
        return jsonify_records(cur.fetchall())

@app.route("/<string:team_stat>", methods=["GET"])
def team_data(team_stat):
    table = _check_team_table(team_stat)
    limit, offset = _pagination()
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(f'SELECT * FROM {table} ORDER BY 1 ASC LIMIT %s OFFSET %s', (limit, offset))
        return jsonify_records(cur.fetchall())

@app.route("/<string:team_stat>/conceded", methods=["GET"])
def team_data_conceded(team_stat):
    table = _check_team_table(f"{team_stat}_conceded")
    limit, offset = _pagination()
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(f'SELECT * FROM {table} ORDER BY 1 ASC LIMIT %s OFFSET %s', (limit, offset))
        return jsonify_records(cur.fetchall())

@app.route("/fpl_predict_summ", methods=["GET"])
def fpl_predict():
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(f"""
                    SELECT * FROM prediction_summary
                    """)
        return jsonify_records(cur.fetchall())

@app.route("/fpl_predict", methods=["GET"])
def fpl_predict():
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(f"""
                    SELECT * FROM predicted_next_gw where match_method != 'none'
                    """)
        return jsonify_records(cur.fetchall())

@app.route("/fpl_predict_<string:model>", methods=["GET"])
def fpl_predict_model(model):
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(f"""
                    SELECT * FROM predicted_next_gw where match_method != 'none' and model = '{model}' 
                    """)
        return jsonify_records(cur.fetchall())

@app.route("/fpl_predict_last_<string:model>", methods=["GET"])
def fpl_predict_model(model):
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(f"""
                    SELECT * FROM predicted_last_gw where match_method != 'none' and model = '{model}' 
                    """)
        return jsonify_records(cur.fetchall())


@app.route("/fpl_data", methods=["GET"])
def fpl_data():
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(f"""
                    SELECT * FROM fpl_elements_enriched
                    WHERE match_method != 'none'
                    """)
        return jsonify_records(cur.fetchall())
    
@app.route("/fpl_data_unmatched", methods=["GET"])
def fpl_data_unmatched():
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(f"""
                    SELECT * FROM fpl_elements_enriched
                    WHERE match_method = 'none'
                    """)
        return jsonify_records(cur.fetchall())

@app.route("/leaders/<string:stat>", methods=["GET"])
def league_leaders(stat):
    if stat == 'xg':
        stat = 'xG'
    elif stat == 'xa':
        stat = 'xA'
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(f"""SELECT * FROM players ORDER BY "{stat}"::Decimal DESC LIMIT 5""")
        return jsonify_records(cur.fetchall())

@app.route("/fbref/player/<string:player>", methods=["GET"])
def fbref_player_data(player):
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT get_player_all_stats(%s)", (player,))
        return (cur.fetchall())
    
@app.route("/fbref/players", methods=["GET"])
def fbref_players():
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT get_all_players_stats()")
        return (cur.fetchall())

@app.route("/fpl_bootstrap", methods=["GET"])
def fpl_bootstrap():
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT fpl_bootstrap()")
        return (cur.fetchall())

@app.route("/fbref/all_teams", methods=["GET"])
def fbref_team_all_data():
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT get_fbref_team_json_all()")
        return (cur.fetchall())

@app.route("/fbref/vs_all_teams", methods=["GET"])
def fbref_vs_team_all_data():
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT get_fbref_vs_team_json_all()")
        return (cur.fetchall())

@app.route("/fbref/team/<string:team>", methods=["GET"])
def fbref_team_data(team):
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT get_fbref_team(%s)", (team,))
        return (cur.fetchall())

@app.route("/fbref/vs_team/<string:team>", methods=["GET"])
def fbref_vs_team_data(team):
    with ConnCtx() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("SELECT get_fbref_vs_team(%s)", (team,))
        return (cur.fetchall())

# -------------------- Error Handlers --------------------
@app.errorhandler(400)
def bad_request(e):
    return jsonify(error="bad_request", message=str(e.description)), 400

@app.errorhandler(404)
def not_found(e):
    return jsonify(error="not_found", message=str(e.description)), 404

@app.errorhandler(503)
def svc_unavailable(e):
    return jsonify(error="service_unavailable", message=str(e.description)), 503

@app.errorhandler(Exception)
def unhandled(e):
    logger.exception("Unhandled error")
    return jsonify(error="internal_error"), 500

@app.route("/debug/geo")
def debug_geo():
    ip = request.args.get("ip") or request.headers.get("CF-Connecting-IP") \
         or request.headers.get("X-Forwarded-For","").split(",")[0].strip() \
         or request.remote_addr
    return jsonify({"ip": ip, "geo": _geo_lookup(ip)})

# -------------------- Startup --------------------
try:
    rebuild_weekly_table()  # warm cache at startup
except Exception:
    logger.exception("Initial weekly table build failed")

try:
    t = threading.Thread(target=_weekly_refresh_loop, name="weekly-table-refresh", daemon=True)
    t.start()
except Exception:
    logger.exception("Failed to start weekly refresh thread")

# -------------------- Entrypoint --------------------
if __name__ == "__main__":
    # For local dev only; in prod use gunicorn with PROMETHEUS_MULTIPROC_DIR set
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8000")), debug=False)

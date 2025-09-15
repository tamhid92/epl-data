import React, { useEffect, useState } from "react";

const API_TOKEN = import.meta.env.VITE_API_TOKEN;

// ---------- helpers ----------
function logoUrl(team) {
  return `/logos/${encodeURIComponent(team)}.png`;
}
function parseUtcToLocal(utcStr) {
  if (!utcStr) return new Date();
  const iso = utcStr.includes("T") ? utcStr : utcStr.replace(" ", "T");
  return new Date(iso.endsWith("Z") ? iso : iso + "Z");
}
function fmtDate(dt) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit" }).format(dt);
}
function fmtTime(dt) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(dt);
}
async function fetchJson(url, { signal } = {}) {
  const res = await fetch(url, {
    signal,
    credentials: "include",
    headers: API_TOKEN ? { "X-API-Token": API_TOKEN } : {},
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}${txt ? ` — ${txt}` : ""}`);
  }
  return res.json();
}

// media query -> bool
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);
  return isMobile;
}

// ---------- row components ----------
function TeamCell({ name, bold = false }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <img
        src={logoUrl(name)}
        alt=""
        className="h-5 w-5 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
        onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
      />
      {/* allow wrapping so full name shows; no truncation */}
      <span className={`min-w-0 whitespace-normal break-normal leading-tight ${bold ? "font-medium" : ""}`}>
        {name}
      </span>
    </div>
  );
}

// Results row: [Date/Time | Home | Score | Away]
function ResultRow({ onClick, date, home, away, score }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="grid w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900
                 grid-cols-[92px_minmax(0,1fr)_64px_minmax(0,1fr)]"
      aria-label="Open match"
    >
      <div className="shrink-0 text-xs text-zinc-500 tabular-nums">
        <div>{fmtDate(date)}</div>
        <div>{fmtTime(date)}</div>
      </div>
      <TeamCell name={home} bold />
      <div className="mx-auto shrink-0 tabular-nums text-sm font-semibold">{score}</div>
      <TeamCell name={away} />
    </button>
  );
}

// Fixture row: [Date/Time | Home | VS | Away | Venue]
function FixtureRow({ onClick, date, home, away, venue }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="grid w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900
            grid-cols-[92px_minmax(0,1fr)_minmax(0,1fr)]"
      aria-label="Open match"
    >
      <div className="shrink-0 text-xs text-zinc-500 tabular-nums">
        <div>{fmtDate(date)}</div>
        <div>{fmtTime(date)}</div>
      </div>
      <TeamCell name={home} bold />
      <div className="min-w-0"><TeamCell name={away} /></div>
    </button>
  );
}

function Chevron({ open }) {
  return (
    <svg
      className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`}
      viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"
    >
      <path d="M7.293 14.707a1 1 0 0 1 0-1.414L9.586 11 7.293 8.707a1 1 0 1 1 1.414-1.414l3 3a1 1 0 0 1 0 1.414l-3 3a1 1 0 0 1-1.414 0z" />
    </svg>
  );
}

function Card({
  title,
  actionLabel,
  onAction,
  columnsClass,
  columns,
  collapsible = false,
  defaultCollapsed = false,
  centerIndex = null,  // NEW: which header col to center (e.g., 2 for “Score”)
  children,
  loading,
  error,
  emptyText,
}) {
  const [open, setOpen] = useState(!defaultCollapsed);

  useEffect(() => {
    // keep in sync if defaultCollapsed changes (e.g., responsive)
    setOpen(!defaultCollapsed);
  }, [defaultCollapsed]);

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 overflow-hidden">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => collapsible && setOpen((v) => !v)}
          className="group inline-flex items-center gap-2"
          aria-expanded={open}
        >
          {collapsible ? (
            <span className="text-zinc-500"><Chevron open={open} /></span>
          ) : null}
          <h3 className="text-sm font-semibold">{title}</h3>
        </button>
        <button
          onClick={onAction}
          className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
        >
          {actionLabel}
        </button>
      </div>

      {/* Column headers (hidden if collapsed or on small screens via md:) */}
      {open && (
        <div
          className={`mb-1 hidden ${columnsClass} px-3 text-[11px] uppercase tracking-wide text-zinc-500 md:grid`}
        >
          {columns.map((c, i) => (
            <div key={i} className={i === centerIndex ? "text-center" : ""}>{c}</div>
          ))}
        </div>
      )}

      {open ? (
        <>
          {loading && <p className="px-3 py-2 text-sm text-zinc-500">Loading…</p>}
          {error && <p className="px-3 py-2 text-sm text-rose-600">Failed to load.</p>}
          {!loading && !error && (React.Children.count(children) ? children : <p className="px-3 py-2 text-sm text-zinc-500">{emptyText}</p>)}
        </>
      ) : null}
    </div>
  );
}

export default function ResultsFixturesDeck({
  apiBase,
  onOpenMatch,
  onShowAllResults,
  onShowAllFixtures,
  resultsLimit = 10,
  fixturesLimit = 10,
}) {
  const isMobile = useIsMobile();
  const [results, setResults] = useState([]);
  const [fixtures, setFixtures] = useState([]);
  const [loading, setLoading] = useState({ results: false, fixtures: false });
  const [err, setErr] = useState({ results: null, fixtures: null });

  // Latest results (last 10, newest first)
  useEffect(() => {
    if (!apiBase) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        setLoading((s) => ({ ...s, results: true }));
        setErr((e) => ({ ...e, results: null }));
        const raw = await fetchJson(`${apiBase}/recents`, { signal: ctrl.signal });
        const items = (Array.isArray(raw) ? raw : [])
          .map((m) => ({
            id: String(m.id),
            date: parseUtcToLocal(m.datetime),
            home: m.home_team,
            away: m.away_team,
            score: `${Number(m.home_goals ?? 0)}–${Number(m.away_goals ?? 0)}`,
          }))
          .sort((a, b) => b.date - a.date)
          .slice(0, resultsLimit);
        setResults(items);
      } catch (e) {
        if (e.name !== "AbortError") setErr((x) => ({ ...x, results: String(e) }));
      } finally {
        setLoading((s) => ({ ...s, results: false }));
      }
    })();
    return () => ctrl.abort();
  }, [apiBase, resultsLimit]);

  // Upcoming fixtures (next 10, soonest first)
  useEffect(() => {
    if (!apiBase) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        setLoading((s) => ({ ...s, fixtures: true }));
        setErr((e) => ({ ...e, fixtures: null }));
        const raw = await fetchJson(`${apiBase}/fixtures/upcoming`, { signal: ctrl.signal });
        const items = (Array.isArray(raw) ? raw : [])
          .map((f) => ({
            id: String(f.id),
            date: parseUtcToLocal(f.datetime),
            home: f.home_team,
            away: f.away_team,
          }))
          .sort((a, b) => a.date - b.date)
          .slice(0, fixturesLimit);
        setFixtures(items);
      } catch (e) {
        if (e.name !== "AbortError") setErr((x) => ({ ...x, fixtures: String(e) }));
      } finally {
        setLoading((s) => ({ ...s, fixtures: false }));
      }
    })();
    return () => ctrl.abort();
  }, [apiBase, fixturesLimit]);

  return (
    <section className="mx-auto w-full max-w-6xl">
      <div className="grid gap-4 md:grid-cols-2">
        {/* Latest Results (no venue) */}
        <Card
          title="Latest Results"
          actionLabel="View all"
          onAction={onShowAllResults}
          collapsible
          defaultCollapsed={isMobile}
          columnsClass="grid-cols-[92px_minmax(0,1fr)_64px_minmax(0,1fr)]"
          columns={["Date", "Home", "Score", "Away"]}
          loading={loading.results}
          error={err.results}
          emptyText="No results yet."
        >
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {results.map((m) => (
              <li key={m.id}>
                <ResultRow
                  onClick={() => onOpenMatch?.(m.id)}
                  date={m.date}
                  home={m.home}
                  away={m.away}
                  score={m.score}
                />
              </li>
            ))}
          </ul>
        </Card>

        {/* Upcoming Fixtures (with venue) */}
        <Card
          title="Upcoming Fixtures"
          actionLabel="View all"
          onAction={onShowAllFixtures}
          collapsible
          defaultCollapsed={isMobile}
          columnsClass="grid-cols-[92px_minmax(0,1fr)_minmax(0,1fr)]"
          columns={["Date", "Home", "Away"]}
          centerIndex={null}   // don’t center any header column here
          loading={loading.fixtures}
          error={err.fixtures}
          emptyText="No upcoming fixtures."
        >
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {fixtures.map((fx) => (
              <li key={fx.id}>
                <FixtureRow
                  onClick={() => onOpenMatch?.(fx.id)}
                  date={fx.date}
                  home={fx.home}
                  away={fx.away}
                  venue={fx.venue}
                />
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </section>
  );
}

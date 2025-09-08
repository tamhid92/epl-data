import React, { useEffect, useMemo, useRef, useState } from "react";
import ModalFrame from "./ModalFrame";

const API_TOKEN = import.meta.env.VITE_API_TOKEN;

/* ---------- utils ---------- */
async function fetchJson(url, { signal } = {}) {
  const res = await fetch(url, {
    signal,
    credentials: 'include', // fine either way for same-origin
    headers: {
      'X-API-Token': API_TOKEN,           // <<< add this
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}${txt ? ` — ${txt}` : ""}`);
  }
  return res.json();
}

function logoUrl(team) {
  return `/logos/${encodeURIComponent(team)}.png`;
}
function parseUtcToLocal(utcStr) {
  const iso = utcStr.replace(" ", "T") + "Z";
  return new Date(iso);
}
function fmtDate(dt) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(dt);
}
function fmtTime(dt) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(dt);
}
const cx = (...a) => a.filter(Boolean).join(" ");

/**
 * ResultsListModal
 * Props:
 *  - open: boolean
 *  - apiBase: string
 *  - teamName?: string                 // initial filter (optional)
 *  - teams?: string[]                  // optional list to populate filter dropdown
 *  - onClose: () => void
 *  - onOpenMatch: (id: string) => void
 */
export default function ResultsListModal({
  open,
  apiBase,
  teamName,
  teams = [],
  onClose,
  onOpenMatch,
}) {
  // Early out keeps hooks stable when closed
  if (!open) return null;

  const closeRef = useRef(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  // local filter (initialized from prop when modal opens)
  const [filterTeam, setFilterTeam] = useState(teamName || "");
  useEffect(() => {
    setFilterTeam(teamName || "");
  }, [teamName, open]);

  useEffect(() => {
    if (open && closeRef.current) closeRef.current.focus();
  }, [open]);

  // Fetch recents (all or by team)
  useEffect(() => {
    if (!apiBase) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        setLoading(true);
        setErr(null);
        const url = filterTeam
          ? `${apiBase}/recents/${encodeURIComponent(filterTeam)}`
          : `${apiBase}/recents`;
        const data = await fetchJson(url, { signal: ctrl.signal });
        const list = Array.isArray(data) ? data : [];
        const mapped = list
          .map((m) => {
            const dt = parseUtcToLocal(m.datetime);
            return {
              id: String(m.id),
              dt,
              home: m.home_team,
              away: m.away_team,
              home_goals: Number(m.home_goals ?? 0),
              away_goals: Number(m.away_goals ?? 0),
              venue: m.venue || "",
            };
          })
          .sort((a, b) => b.dt - a.dt);
        setRows(mapped);
      } catch (e) {
        if (e.name !== "AbortError") setErr(String(e));
      } finally {
        setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [apiBase, filterTeam]);

  // If no teams prop, derive from data (fallback)
  const teamOptions = useMemo(() => {
    if (teams && teams.length) return [...teams].sort((a, b) => a.localeCompare(b));
    const s = new Set();
    rows.forEach((r) => { s.add(r.home); s.add(r.away); });
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [teams, rows]);

  // Quick stats
  const stats = useMemo(() => {
    const total = rows.length;
    const totalGoals = rows.reduce((acc, m) => acc + m.home_goals + m.away_goals, 0);
    const avgGoals = total ? (totalGoals / total) : 0;

    if (!filterTeam) {
      return { total, totalGoals, avgGoals, w: null, d: null, l: null, gf: null, ga: null };
    }
    let w = 0, d = 0, l = 0, gf = 0, ga = 0;
    for (const m of rows) {
      const isHome = m.home === filterTeam;
      const F = isHome ? m.home_goals : (m.away === filterTeam ? m.away_goals : 0);
      const A = isHome ? m.away_goals : (m.away === filterTeam ? m.home_goals : 0);
      gf += F; ga += A;
      if (F > A) w++; else if (F === A) d++; else l++;
    }
    return { total, totalGoals, avgGoals, w, d, l, gf, ga };
  }, [rows, filterTeam]);

  return (
    <ModalFrame open={open} onClose={onClose} maxWidth="max-w-5xl">
      {/* header */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          {/* EPL logo when not filtered; team logo when filtered */}
          <img
            src={filterTeam ? logoUrl(filterTeam) : "/logos/epl.png"}  // ← EPL badge
            alt=""
            className="h-8 w-8 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
            onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
          />
          <h3 className="text-lg font-semibold">
            {filterTeam ? `${filterTeam} — Matches Played` : "All Matches Played"}
          </h3>
        </div>
        <div className="flex items-center gap-2">
          {/* Team filter */}
          <select
            value={filterTeam}
            onChange={(e) => setFilterTeam(e.target.value)}
            className="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            title="Filter by team"
          >
            <option value="">All teams</option>
            {teamOptions.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          {filterTeam && (
            <button
              onClick={() => setFilterTeam("")}
              className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              title="Clear team filter"
            >
              Clear
            </button>
          )}
          <button
            ref={closeRef}
            onClick={onClose}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            Close
          </button>
        </div>
      </div>

      {/* quick stats bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-zinc-50/60 px-4 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-900/50">
        <Pill>Matches: <b className="tabular-nums">{stats.total}</b></Pill>
        {!filterTeam ? (
          <>
            <Pill>Total Goals: <b className="tabular-nums">{stats.totalGoals}</b></Pill>
            <Pill>Avg Goals/Match: <b className="tabular-nums">{stats.avgGoals.toFixed(2)}</b></Pill>
          </>
        ) : (
          <>
            <Pill>W-D-L: <b>{stats.w}</b>-<b>{stats.d}</b>-<b>{stats.l}</b></Pill>
            <Pill>GF/GA: <b className="tabular-nums">{stats.gf}</b>/<b className="tabular-nums">{stats.ga}</b></Pill>
          </>
        )}
      </div>

      {/* scrollable body */}
      <div className="min-h-0 grow overflow-y-auto p-4">
        {loading && <p className="text-sm text-zinc-500">Loading…</p>}
        {err && <p className="text-sm text-rose-600">Failed to load matches.</p>}
        {!loading && !err && rows.length === 0 && (
          <p className="text-sm text-zinc-500">No matches available.</p>
        )}

        <div className="overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800">
          <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            <thead className="sticky top-0 z-10 bg-zinc-50/90 backdrop-blur dark:bg-zinc-900/70">
              <tr className="text-xs uppercase tracking-wider text-zinc-600 dark:text-zinc-300">
                {/* Order: date | home | score | away | venue */}
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Home</th>
                <th className="px-3 py-2 text-center">Score</th>
                <th className="px-3 py-2 text-left">Away</th>
                <th className="px-3 py-2 text-left">Venue</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 bg-white dark:divide-zinc-800 dark:bg-zinc-950">
              {rows.map((m, idx) => {
                const homeWon = m.home_goals > m.away_goals;
                const awayWon = m.away_goals > m.home_goals;
                const isFilteredHome = filterTeam && m.home === filterTeam;
                const isFilteredAway = filterTeam && m.away === filterTeam;

                return (
                  <tr
                    key={m.id}
                    className={cx(
                      "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900",
                      idx % 2 ? "bg-zinc-50/40 dark:bg-zinc-900/30" : ""
                    )}
                    onClick={() => onOpenMatch?.(m.id)}
                    title="Open match center"
                  >
                    {/* Date */}
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="tabular-nums">{fmtDate(m.dt)}</div>
                      <div className="text-xs text-zinc-500">{fmtTime(m.dt)}</div>
                    </td>

                    {/* Home */}
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <img
                          src={logoUrl(m.home)}
                          alt=""
                          className="h-5 w-5 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
                          onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
                        />
                        <span
                          className={cx(
                            "font-medium",
                            homeWon ? "text-emerald-600 dark:text-emerald-400" : "",
                            isFilteredHome ? "underline decoration-dotted" : ""
                          )}
                        >
                          {m.home}
                        </span>
                      </div>
                    </td>

                    {/* Score */}
                    <td className="px-3 py-2 text-center tabular-nums">
                      <ResultBadge
                        home={m.home_goals}
                        away={m.away_goals}
                        highlightSide={homeWon ? "h" : awayWon ? "a" : null}
                      />
                    </td>

                    {/* Away */}
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <img
                          src={logoUrl(m.away)}
                          alt=""
                          className="h-5 w-5 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
                          onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
                        />
                        <span
                          className={cx(
                            awayWon ? "text-emerald-600 dark:text-emerald-400" : "",
                            isFilteredAway ? "underline decoration-dotted" : ""
                          )}
                        >
                          {m.away}
                        </span>
                      </div>
                    </td>

                    {/* Venue */}
                    <td className="px-3 py-2">{m.venue}</td>

                    {/* Action */}
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={(e) => { e.stopPropagation(); onOpenMatch?.(m.id); }}
                        className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-2 text-xs text-zinc-500">
          This list reflects what the API returns (ordered most recent first).
        </p>
      </div>
    </ModalFrame>
  );
}

/* ---------- tiny UI bits ---------- */
function Pill({ children }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
      {children}
    </span>
  );
}

function ResultBadge({ home, away, highlightSide }) {
  const base =
    "inline-flex items-center justify-center rounded-lg border px-2 py-1 text-xs tabular-nums";
  const homeCls = cx(
    base,
    "rounded-r-none border-zinc-300 dark:border-zinc-700",
    highlightSide === "h"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : "bg-zinc-50 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
  );
  const midCls = cx(
    "inline-flex items-center justify-center border-y border-zinc-300 px-2 py-1 text-[10px] text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
  );
  const awayCls = cx(
    base,
    "rounded-l-none border-zinc-300 dark:border-zinc-700",
    highlightSide === "a"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : "bg-zinc-50 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
  );

  return (
    <span className="inline-flex items-stretch rounded-lg shadow-sm">
      <span className={homeCls}>{home}</span>
      <span className={midCls}>—</span>
      <span className={awayCls}>{away}</span>
    </span>
  );
}

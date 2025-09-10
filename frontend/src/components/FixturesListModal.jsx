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
function logoUrl(team) {
  return `/logos/${encodeURIComponent(team)}.png`;
}

/**
 * FixturesListModal
 * Props:
 *  - open: boolean
 *  - apiBase: string
 *  - teams?: string[]
 *  - onClose: () => void
 */
export default function FixturesListModal({ open, apiBase, teams = [], onClose }) {
  const closeRef = useRef(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  // Team filter (uses /fixtures/upcoming/<team> when set)
  const [filterTeam, setFilterTeam] = useState("");

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
  }, [open]);

  // Fetch fixtures (all or by team)
  useEffect(() => {
    if (!open || !apiBase) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        setLoading(true);
        setErr(null);
        const url = filterTeam
          ? `${apiBase}/fixtures/upcoming/${encodeURIComponent(filterTeam)}`
          : `${apiBase}/fixtures/upcoming`;
        const data = await fetchJson(url, { signal: ctrl.signal });
        const list = Array.isArray(data) ? data : [];
        const mapped = list
          .map((f) => {
            const dt = parseUtcToLocal(f.datetime);
            return {
              id: String(f.id),
              dt,
              home: f.home_team,
              away: f.away_team,
              venue: f.venue || "",
            };
          })
          .sort((a, b) => a.dt - b.dt);
        setRows(mapped);
      } catch (e) {
        if (e.name !== "AbortError") setErr(String(e));
      } finally {
        setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [open, apiBase, filterTeam]);

  // Team options (prefer prop; fallback to derive from data)
  const teamOptions = useMemo(() => {
    if (teams?.length) return [...teams].sort((a, b) => a.localeCompare(b));
    const s = new Set();
    rows.forEach((r) => { s.add(r.home); s.add(r.away); });
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [teams, rows]);

  if (!open) return null;

  return (
    <ModalFrame open={open} onClose={onClose}>
      {/* Header (inside ModalFrame because the frame doesn't render one) */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex min-w-0 items-center gap-3">
          <img
            src="/logos/epl.png"
            alt=""
            className="h-8 w-8 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
            onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
          />
        <h3 className="truncate text-lg font-semibold tracking-tight">
            Upcoming Fixtures
          </h3>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <label className="sr-only" htmlFor="fixtures-team-filter">Filter by team</label>
          <select
            id="fixtures-team-filter"
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
            onClick={() => { try { history.back(); } catch { onClose?.(); } }}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            Close
          </button>
        </div>
      </div>

      {/* Body (scrollable) */}
      <div className="max-h-[68vh] overflow-y-auto p-4">
        {loading && <p className="p-1 text-sm text-zinc-500">Loading…</p>}
        {err && <p className="p-1 text-sm text-rose-600">Failed to load fixtures.</p>}
        {!loading && !err && rows.length === 0 && (
          <p className="p-1 text-sm text-zinc-500">No upcoming fixtures.</p>
        )}

        <div className="overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800">
          <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            <thead className="sticky top-0 z-10 bg-zinc-50/90 backdrop-blur dark:bg-zinc-900/70">
              <tr className="text-xs uppercase tracking-wider text-zinc-600 dark:text-zinc-300">
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Home</th>
                <th className="px-3 py-2 text-left">Away</th>
                <th className="px-3 py-2 text-left">Venue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 bg-white dark:divide-zinc-800 dark:bg-zinc-950">
              {rows.map((m, idx) => (
                <tr
                  key={m.id}
                  className={idx % 2 ? "bg-zinc-50/40 dark:bg-zinc-900/30" : ""}
                >
                  {/* Date / time */}
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
                      <span className="font-medium">{m.home}</span>
                    </div>
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
                      <span>{m.away}</span>
                    </div>
                  </td>

                  {/* Venue */}
                  <td className="px-3 py-2">{m.venue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-2 px-1 text-xs text-zinc-500">
          Showing upcoming fixtures from the API (soonest first).
        </p>
      </div>
    </ModalFrame>
  );
}

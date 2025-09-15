import React, { useEffect, useMemo, useState } from "react";

/**
 * Props:
 *  - rows?: Array<object>        // if provided, table renders from these rows (no fetch)
 *  - endpoint?: string           // fallback URL to fetch if rows not provided
 *  - onOpenTeam?: (teamName: string) => void
 */
export default function StandingsTable({ rows: rowsProp, endpoint, onOpenTeam }) {
  const controlled = typeof rowsProp !== "undefined";
  const [rows, setRows] = useState(Array.isArray(rowsProp) ? rowsProp : []);
  const [status, setStatus] = useState(controlled ? "ready" : "idle");

  // Keep in sync when parent controls the data
  useEffect(() => {
    if (controlled) {
      setRows(Array.isArray(rowsProp) ? rowsProp : []);
      setStatus("ready");
    }
  }, [controlled, rowsProp]);

  // Only fetch if not controlled and endpoint is provided
  useEffect(() => {
    if (controlled || !endpoint) return;
    let cancelled = false;
    const ctrl = new AbortController();

    (async () => {
      try {
        setStatus("loading");
        const res = await fetch(endpoint, {
          signal: ctrl.signal,
          headers: { "X-API-TOKEN": import.meta.env.VITE_API_TOKEN },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setRows(Array.isArray(data) ? data : []);
        if (!cancelled) setStatus("ready");
      } catch (err) {
        console.error("Failed to load standings:", err);
        if (!cancelled) setStatus("error");
      }
    })();

    return () => { cancelled = true; ctrl.abort(); };
  }, [controlled, endpoint]);

  const table = useMemo(() => {
    const normalized = (rows || []).map((r) => {
      const MP  = Number(r.M)   || 0;
      const W   = Number(r.W)   || 0;
      const D   = Number(r.D)   || 0;
      const L   = Number(r.L)   || 0;
      const GF  = Number(r.G)   || 0;
      const GA  = Number(r.GA)  || 0;
      const Pts = Number(r.PTS) || 0;
      const GD  = GF - GA;
      const xG  = Number(r.xG)  || 0;
      return { Team: r.Team, MP, W, D, L, GF, GA, GD, Pts, xG };
    });

    normalized.sort((a, b) =>
      b.Pts - a.Pts || b.GD - a.GD || b.GF - a.GF
    );

    return normalized.map((r, i) => ({ Pos: i + 1, ...r }));
  }, [rows]);

  function bandStyles(pos) {
    let row = "", border = "border-transparent", posText = "";
    if (pos >= 1 && pos <= 4) {
      row = "bg-emerald-50 dark:bg-emerald-950/30";
      border = "border-emerald-400";
      posText = "text-emerald-700 dark:text-emerald-300";
    } else if (pos === 5) {
      row = "bg-lime-50 dark:bg-lime-950/30";
      border = "border-lime-400";
      posText = "text-lime-700 dark:text-lime-300";
    } else if (pos >= 18) {
      row = "bg-rose-50 dark:bg-rose-950/30";
      border = "border-rose-400";
      posText = "text-rose-700 dark:text-rose-300";
    }
    return { row, border, posText };
  }

  if (status === "loading") {
    return (
      <div className="rounded-2xl border border-zinc-200 p-6 text-center dark:border-zinc-800">
        <p className="text-sm text-zinc-600 dark:text-zinc-300">Loading standings…</p>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
        Failed to load standings.
      </div>
    );
  }

  return (
    <div className="w-full overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800">
      <table className="min-w-full divide-y divide-zinc-200 text-center dark:divide-zinc-800">
        <thead className="bg-zinc-50/70 dark:bg-zinc-900/60">
          <tr className="text-left text-xs font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-300">
            <th className="px-4 py-3 text-center">Pos</th>
            <th className="px-4 py-3 text-center">Team</th>
            <th className="px-2 py-3 text-center">MP</th>
            <th className="px-2 py-3 text-center">W</th>
            <th className="px-2 py-3 text-center">D</th>
            <th className="px-2 py-3 text-center">L</th>
            <th className="px-2 py-3 text-center">GF</th>
            <th className="px-2 py-3 text-center">GA</th>
            <th className="px-2 py-3 text-center">GD</th>
            <th className="px-4 py-3 text-center">Pts</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 bg-white text-sm dark:divide-zinc-800 dark:bg-zinc-950">
          {table.map((r) => {
            const s = bandStyles(r.Pos);
            return (
              <tr key={r.Pos} className={`${s.row} hover:bg-zinc-50/70 dark:hover:bg-zinc-900/50`}>
                <td className={`px-4 py-2 font-semibold tabular-nums border-l-4 ${s.border} ${s.posText}`}>{r.Pos}</td>
                <td className="px-4 py-2">
                  <button
                    onClick={() => onOpenTeam && onOpenTeam(r.Team)}
                    className="inline-flex items-center justify-center rounded-lg px-2 py-1 font-medium text-zinc-900 underline decoration-dotted underline-offset-4 hover:bg-zinc-100 dark:text-zinc-100 dark:hover:bg-zinc-900"
                    title={`Open ${r.Team} details`}
                  >
                    {r.Team}
                  </button>
                </td>
                <td className="px-2 py-2">{r.MP}</td>
                <td className="px-2 py-2">{r.W}</td>
                <td className="px-2 py-2">{r.D}</td>
                <td className="px-2 py-2">{r.L}</td>
                <td className="px-2 py-2">{r.GF}</td>
                <td className="px-2 py-2">{r.GA}</td>
                <td className="px-2 py-2">{r.GD > 0 ? `+${r.GD}` : r.GD}</td>
                <td className="px-4 py-2 font-semibold">{r.Pts}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

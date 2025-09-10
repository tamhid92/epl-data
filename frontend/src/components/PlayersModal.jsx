// components/PlayersModal.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import ModalFrame from "./ModalFrame";
import {
  ResponsiveContainer,
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
  RadialBarChart, RadialBar,
} from "recharts";
import { HelpCircle } from "lucide-react";

const API_TOKEN = import.meta.env.VITE_API_TOKEN;

/* ---------- tiny hover helper ---------- */
function HelpHint({ text, className = "" }) {
  return (
    <span className={`relative inline-flex items-center ${className}`}>
      <button
        type="button"
        className="group inline-flex items-center justify-center rounded-full p-0.5 text-zinc-500 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:text-zinc-400 dark:hover:text-zinc-200"
        aria-label="What is this?"
        title={text}
      >
        <HelpCircle className="h-4 w-4" />
        {/* custom tooltip */}
        <span className="pointer-events-none absolute left-1/2 top-[125%] z-30 hidden w-64 -translate-x-1/2 rounded-md border border-zinc-200 bg-white px-2.5 py-2 text-[11px] leading-snug text-zinc-700 shadow-lg group-hover:block dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
          {text}
        </span>
      </button>
    </span>
  );
}

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

const num = (v) => (Number.isFinite(+v) ? +v : 0);
const per90 = (v, mins) => (num(mins) > 0 ? (num(v) / num(mins)) * 90 : 0);
const fmt2 = (x) => (Number.isFinite(+x) ? (+x).toFixed(2) : "0.00");
const cx = (...a) => a.filter(Boolean).join(" ");
const clamp01 = (x) => Math.max(0, Math.min(1, x));
function logoUrl(team) { return `/logos/${encodeURIComponent(team)}.png`; }
function posBucket(raw = "") {
  const s = String(raw).toUpperCase();
  if (s.includes("GK")) return "GK";
  if (s.includes("D")) return "D";
  if (s.includes("M")) return "M";
  if (s.includes("F") || s.includes("S")) return "F";
  return "Other";
}
/** Percentile rank of v among arr (inclusive) -> [0..1] */
function percentile(v, arr) {
  if (!arr?.length) return 0;
  let c = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] <= v) c++;
  return clamp01(c / arr.length);
}

/* ---------- help text for metrics ---------- */
const HELP = {
  Minutes: "Total minutes played. Per-90 rates below normalize stats per full match to compare different playing times.",
  Goals: "Goals scored. Penalties included if applicable to your dataset.",
  Assists: "Assists credited.",
  xG: "Expected Goals: quality of chances taken, independent of finishing. Sum across minutes.",
  xA: "Expected Assists: likelihood that a pass becomes a goal. Sum across minutes.",
  "xG/90": "Expected Goals per 90 minutes. Higher means the player consistently gets good shooting chances.",
  "xA/90": "Expected Assists per 90 minutes. Higher means the player consistently creates good chances for teammates.",
  "Shots/90": "Shots taken per 90 minutes.",
  "KP/90": "Key Passes per 90 minutes: passes leading directly to a shot.",
  "xGBuildup/90": "Non-shot involvement in moves that end in a shot (excludes shots & key passes). Proxy for buildup contribution.",
  "xGChain/90": "Any involvement in shot-ending sequences (includes shots & key passes). Proxy for total chance involvement.",
  "xG/90 percentile": "Percentile vs league peers (prefer same position). 100% = top of the group for xG per 90.",
  "xA/90 percentile": "Percentile vs league peers (prefer same position). 100% = top of the group for xA per 90.",
  "Percentile bars":
    "Horizontal bars show where the player ranks for each metric vs league peers (position-aware where possible).",
  "Profile Radar":
    "Radar shows the player’s percentile profile across metrics at a glance. Larger area = stronger relative performance.",
};

/* ---------- main ---------- */
export default function PlayersModal({
  open,
  apiBase,
  teams = [],
  onClose,
  /** NEW: preselect when opened from TeamModal */
  initialTeam,
  initialPlayerId,
  initialPlayerName, // optional fallback by name
}) {
  const closeRef = useRef(null);

  // All players across league
  const [allPlayers, setAllPlayers] = useState([]);
  const [loadingAll, setLoadingAll] = useState(false);
  const [errAll, setErrAll] = useState(null);

  // Filters
  const [teamFilter, setTeamFilter] = useState(""); // "" = All
  const [posFilter, setPosFilter] = useState("");   // "" = All | GK | D | M | F
  const [query, setQuery] = useState("");

  // Selected player
  const [selectedId, setSelectedId] = useState(null);
  const selected = useMemo(
    () => allPlayers.find((p) => String(p.id) === String(selectedId)) || null,
    [allPlayers, selectedId]
  );

  // Keep refs to list items to scroll selected into view
  const itemRefs = useRef(new Map());
  useEffect(() => {
    if (!open || !selectedId) return;
    const el = itemRefs.current.get(String(selectedId));
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId, open]);

  // Adopt preselect when opening / when initial props change
  useEffect(() => {
    if (!open) return;
    setTeamFilter(initialTeam || "");
    setPosFilter("");
    setQuery("");
    if (initialPlayerId) setSelectedId(String(initialPlayerId));
    // If we only have a name, we'll try to match after fetch completes.
  }, [open, initialTeam, initialPlayerId]);

  // Fetch everyone (concurrent by team), prioritizing the initial team first so the preselected player is ready ASAP
  useEffect(() => {
    if (!open || !apiBase || !teams?.length) return;
    let cancelled = false;

    (async () => {
      try {
        setLoadingAll(true);
        setErrAll(null);

        // Put initialTeam at the front of the queue
        const queue = [...teams];
        if (initialTeam) {
          const idx = queue.indexOf(initialTeam);
          if (idx > -1) {
            queue.splice(idx, 1);
            queue.unshift(initialTeam);
          }
        }

        const MAX_CONC = 5;
        const results = [];

        async function run(team) {
          try {
            const data = await fetchJson(`${apiBase}/players/${encodeURIComponent(team)}`);
            const arr = Array.isArray(data) ? data : [];
            for (const r of arr) {
              const mins = num(r.time);
              const bucket = posBucket(r.position);
              results.push({
                team_title: r.team_title || team,
                team: team,
                id: String(r.id),
                player_name: r.player_name,
                position: r.position,
                time: mins,
                goals: num(r.goals),
                assists: num(r.assists),
                shots: num(r.shots),
                key_passes: num(r.key_passes),
                xG: num(r.xG),
                xA: num(r.xA),
                npxG: num(r.npxG),
                xGBuildup: num(r.xGBuildup),
                xGChain: num(r.xGChain),
                xG90: per90(r.xG, mins),
                xA90: per90(r.xA, mins),
                Shots90: per90(r.shots, mins),
                KP90: per90(r.key_passes, mins),
                xGBuildup90: per90(r.xGBuildup, mins),
                xGChain90: per90(r.xGChain, mins),
                _bucket: bucket,
              });
            }
          } catch {
            // ignore a single team’s failure
          }
        }

        const workers = Array.from({ length: Math.min(MAX_CONC, queue.length) }, async () => {
          while (queue.length && !cancelled) {
            const t = queue.shift();
            await run(t);
            if (cancelled) return;
            // As results accumulate, update state in batches for responsiveness
            setAllPlayers((prev) => {
              const merged = prev.length ? prev : [];
              // We don't want duplicates if state updates multiple times
              const seen = new Set(merged.map((p) => `${p.team}|${p.id}`));
              const newOnes = results.filter((p) => !seen.has(`${p.team}|${p.id}`));
              const out = [...merged, ...newOnes];
              out.sort((a, b) => b.time - a.time);
              return out;
            });
          }
        });

        await Promise.all(workers);

        if (cancelled) return;

        // Finalize (ensure sorted)
        setAllPlayers((prev) => {
          const out = [...prev];
          out.sort((a, b) => b.time - a.time);
          return out;
        });

        // If we only had a name to preselect, try to pick it now
        if (!initialPlayerId && initialPlayerName) {
          const hit = results.find(
            (p) =>
              p.player_name?.toLowerCase() === initialPlayerName.toLowerCase() &&
              (!initialTeam || p.team === initialTeam)
          );
          if (hit) setSelectedId(String(hit.id));
        }
      } catch (e) {
        if (!cancelled) setErrAll(String(e));
      } finally {
        if (!cancelled) setLoadingAll(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, apiBase, teams, initialTeam, initialPlayerId, initialPlayerName]);

  // Visible list by filter & search
  const filtered = useMemo(() => {
    let arr = allPlayers;
    if (teamFilter) arr = arr.filter((p) => p.team === teamFilter);
    if (posFilter)  arr = arr.filter((p) => p._bucket === posFilter);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      arr = arr.filter(
        (p) =>
          p.player_name.toLowerCase().includes(q) ||
          p.team.toLowerCase().includes(q)
      );
    }
    return arr;
  }, [allPlayers, teamFilter, posFilter, query]);

  // Keep a selection, but DO NOT override an explicit preselection
  useEffect(() => {
    if (!open) return;
    if (!filtered.length) return;
    if (selectedId == null) {
      setSelectedId(filtered[0].id);
    }
  }, [filtered, open, selectedId]);

  // Position-aware distributions for percentiles
  const dist = useMemo(() => {
    const byBucket = (bucket, key) =>
      allPlayers.filter((p) => p._bucket === bucket).map((p) => p[key]).filter(Number.isFinite);
    return {
      xG90: {
        GK: byBucket("GK", "xG90"), D: byBucket("D", "xG90"), M: byBucket("M", "xG90"), F: byBucket("F", "xG90"),
        ALL: allPlayers.map((p) => p.xG90).filter(Number.isFinite),
      },
      xA90: {
        GK: byBucket("GK", "xA90"), D: byBucket("D", "xA90"), M: byBucket("M", "xA90"), F: byBucket("F", "xA90"),
        ALL: allPlayers.map((p) => p.xA90).filter(Number.isFinite),
      },
      Shots90: {
        GK: byBucket("GK", "Shots90"), D: byBucket("D", "Shots90"), M: byBucket("M", "Shots90"), F: byBucket("F", "Shots90"),
        ALL: allPlayers.map((p) => p.Shots90).filter(Number.isFinite),
      },
      KP90: {
        GK: byBucket("GK", "KP90"), D: byBucket("D", "KP90"), M: byBucket("M", "KP90"), F: byBucket("F", "KP90"),
        ALL: allPlayers.map((p) => p.KP90).filter(Number.isFinite),
      },
      xGBuildup90: {
        GK: byBucket("GK", "xGBuildup90"), D: byBucket("D", "xGBuildup90"),
        M: byBucket("M", "xGBuildup90"), F: byBucket("F", "xGBuildup90"),
        ALL: allPlayers.map((p) => p.xGBuildup90).filter(Number.isFinite),
      },
      xGChain90: {
        GK: byBucket("GK", "xGChain90"), D: byBucket("D", "xGChain90"),
        M: byBucket("M", "xGChain90"), F: byBucket("F", "xGChain90"),
        ALL: allPlayers.map((p) => p.xGChain90).filter(Number.isFinite),
      },
    };
  }, [allPlayers]);

  if (!open) return null;

  return (
    <ModalFrame open={open} onClose={onClose} maxWidth="max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          <img
            src="/logos/epl.png"
            alt=""
            className="h-8 w-8 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
            onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
          />
          <h3 className="text-lg font-semibold">Players Explorer</h3>
          {loadingAll && (
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200">
              Loading players…
            </span>
          )}
          {errAll && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900/40 dark:text-amber-200">
              Some teams failed to load
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            ref={closeRef}
            onClick={() => { try { history.back(); } catch { onClose?.(); } }}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            Close
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="grid max-h-[calc(100vh-180px)] grid-rows-[1fr] gap-4 overflow-hidden p-4">
        <div className="grid grid-cols-1 gap-4 overflow-hidden lg:grid-cols-[0.85fr_1.35fr]">
          {/* LEFT: Filters + list */}
          <div className="min-h-0 overflow-y-auto rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800">
            {/* Filters */}
            <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {/* Team select with logo */}
              <div className="flex items-center gap-2">
                {teamFilter && (
                  <img
                    src={logoUrl(teamFilter)}
                    alt=""
                    className="h-6 w-6 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
                    onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
                  />
                )}
                <select
                  value={teamFilter}
                  onChange={(e) => { setTeamFilter(e.target.value); }}
                  className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 dark:border-zinc-700 dark:bg-zinc-900"
                  title="Filter by team"
                >
                  <option value="">All teams</option>
                  {teams.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>

              {/* Position filter */}
              <select
                value={posFilter}
                onChange={(e) => setPosFilter(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 dark:border-zinc-700 dark:bg-zinc-900"
                title="Filter by position"
              >
                <option value="">All positions</option>
                <option value="GK">GK</option>
                <option value="D">D</option>
                <option value="M">M</option>
                <option value="F">F</option>
              </select>

              {/* Search */}
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search players or teams…"
                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </div>

            {/* List */}
            {filtered.length === 0 ? (
              <p className="text-sm text-zinc-500">No players match your filters.</p>
            ) : (
              <ul className="space-y-2">
                {filtered.map((p) => (
                  <li key={p.id} ref={(el) => { if (el) itemRefs.current.set(String(p.id), el); }}>
                    <button
                      onClick={() => setSelectedId(String(p.id))}
                      className={cx(
                        "flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition hover:shadow-sm",
                        String(p.id) === String(selectedId)
                          ? "border-indigo-500 bg-indigo-50/60 dark:border-indigo-400 dark:bg-indigo-900/20"
                          : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
                      )}
                      title={p.player_name}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <img
                          src={logoUrl(p.team)}
                          alt=""
                          className="h-6 w-6 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
                          onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
                        />
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-semibold">{p.player_name}</div>
                          <div className="text-[10px] text-zinc-500">
                            {p.team} • {p.position || "—"} • Min <span className="tabular-nums">{p.time}</span>
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-1 text-center">
                        <Chip label="G"  val={p.goals} help="Goals scored." />
                        <Chip label="A"  val={p.assists} help="Assists credited." />
                        <Chip label="xG" val={fmt2(p.xG)} help={HELP["xG"]} />
                        <Chip label="xA" val={fmt2(p.xA)} help={HELP["xA"]} />
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* RIGHT: Details & visuals */}
          <div className="min-h-0 overflow-y-auto rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800">
            {!selected ? (
              <p className="text-sm text-zinc-500">Select a player to view details.</p>
            ) : (
              <PlayerDetails
                p={selected}
                pct={{
                  xG90: percentile(
                    selected.xG90,
                    (dist.xG90[selected._bucket]?.length ? dist.xG90[selected._bucket] : dist.xG90.ALL)
                  ),
                  xA90: percentile(
                    selected.xA90,
                    (dist.xA90[selected._bucket]?.length ? dist.xA90[selected._bucket] : dist.xA90.ALL)
                  ),
                  Shots90: percentile(
                    selected.Shots90,
                    (dist.Shots90[selected._bucket]?.length ? dist.Shots90[selected._bucket] : dist.Shots90.ALL)
                  ),
                  KP90: percentile(
                    selected.KP90,
                    (dist.KP90[selected._bucket]?.length ? dist.KP90[selected._bucket] : dist.KP90.ALL)
                  ),
                  xGBuildup90: percentile(
                    selected.xGBuildup90,
                    (dist.xGBuildup90[selected._bucket]?.length ? dist.xGBuildup90[selected._bucket] : dist.xGBuildup90.ALL)
                  ),
                  xGChain90: percentile(
                    selected.xGChain90,
                    (dist.xGChain90[selected._bucket]?.length ? dist.xGChain90[selected._bucket] : dist.xGChain90.ALL)
                  ),
                }}
              />
            )}
          </div>
        </div>
      </div>
    </ModalFrame>
  );
}

/* ---------- small list chip ---------- */
function Chip({ label, val, help }) {
  return (
    <div className="rounded-md bg-zinc-50 px-1.5 py-1 text-[10px] dark:bg-zinc-900" title={help}>
      <div className="tabular-nums text-xs font-semibold">{val}</div>
      <div className="inline-flex items-center gap-1 text-[9px] text-zinc-500">
        <span>{label}</span>
        {help ? <HelpHint text={help} /> : null}
      </div>
    </div>
  );
}

/* ---------- details ---------- */
function PlayerDetails({ p, pct }) {
  const statCards = [
    { k: "Minutes", v: p.time },
    { k: "Goals", v: p.goals },
    { k: "Assists", v: p.assists },
    { k: "xG", v: fmt2(p.xG) },
    { k: "xA", v: fmt2(p.xA) },
    { k: "xG/90", v: fmt2(p.xG90) },
    { k: "xA/90", v: fmt2(p.xA90) },
    { k: "Shots/90", v: fmt2(p.Shots90) },
    { k: "KP/90", v: fmt2(p.KP90) },
    { k: "xGBuildup/90", v: fmt2(p.xGBuildup90) },
    { k: "xGChain/90", v: fmt2(p.xGChain90) },
  ];

  const radarData = [
    { k: "xG/90", v: pct.xG90 * 100 },
    { k: "xA/90", v: pct.xA90 * 100 },
    { k: "Shots/90", v: pct.Shots90 * 100 },
    { k: "KP/90", v: pct.KP90 * 100 },
    { k: "xGBuildup/90", v: pct.xGBuildup90 * 100 },
    { k: "xGChain/90", v: pct.xGChain90 * 100 },
  ];

  const pbarData = [
    { k: "xG/90", pct: Math.round(pct.xG90 * 100), val: p.xG90 },
    { k: "xA/90", pct: Math.round(pct.xA90 * 100), val: p.xA90 },
    { k: "Shots/90", pct: Math.round(pct.Shots90 * 100), val: p.Shots90 },
    { k: "KP/90", pct: Math.round(pct.KP90 * 100), val: p.KP90 },
    { k: "xGBuildup/90", pct: Math.round(pct.xGBuildup90 * 100), val: p.xGBuildup90 },
    { k: "xGChain/90", pct: Math.round(pct.xGChain90 * 100), val: p.xGChain90 },
  ];

  const gaugeData = (val) => [{ name: "pct", value: Math.round(val * 100) }];

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-base font-semibold">{p.player_name}</div>
          <div className="text-xs text-zinc-500">
            {p.team} • {p.position || "—"} ({p._bucket})
          </div>
        </div>
        <img
          src={`/logos/${encodeURIComponent(p.team)}.png`}
          alt=""
          className="h-8 w-8 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
          onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
        />
      </div>

      {/* stat cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {statCards.map((s) => (
          <div
            key={s.k}
            className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
            title={HELP[s.k]}
          >
            <div className="flex items-center justify-between">
              <div className="text-xs text-zinc-500">{s.k}</div>
              {HELP[s.k] ? <HelpHint text={HELP[s.k]} /> : null}
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{s.v}</div>
          </div>
        ))}
      </div>

      {/* quick gauges (xG/90 & xA/90) */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Gauge
          title="xG/90 percentile"
          data={gaugeData(pct.xG90)}
          help={HELP["xG/90 percentile"]}
        />
        <Gauge
          title="xA/90 percentile"
          data={gaugeData(pct.xA90)}
          help={HELP["xA/90 percentile"]}
        />
      </div>

      {/* percentile bars (fast & readable) */}
      <div className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800" title={HELP["Percentile bars"]}>
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <span>Percentile bars</span>
          <HelpHint text={HELP["Percentile bars"]} />
        </div>
        <div className="h-64">
          <ResponsiveContainer>
            <BarChart data={pbarData} layout="vertical" margin={{ left: 24, right: 12, top: 4, bottom: 4 }}>
              <CartesianGrid horizontal vertical={false} strokeDasharray="3 3" />
              <XAxis type="number" domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
              <YAxis dataKey="k" type="category" tick={{ fontSize: 11 }} width={88} />
              <Tooltip formatter={(v, n, obj) => [`${v}%  (val: ${fmt2(obj.payload.val)})`, "Percentile"]} />
              <Bar dataKey="pct" radius={[6, 6, 6, 6]}>
                {pbarData.map((d, i) => (
                  <Cell key={i} fill={d.k.includes("xG") ? "#10B981" : d.k.includes("xA") ? "#6366F1" : "#94A3B8"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* radar */}
      <div className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800" title={HELP["Profile Radar"]}>
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <span>Profile Radar (percentiles)</span>
          <HelpHint text={HELP["Profile Radar"]} />
        </div>
        <div className="h-64">
          <ResponsiveContainer>
            <RadarChart data={radarData}>
              <PolarGrid />
              <PolarAngleAxis dataKey="k" tick={{ fontSize: 11 }} />
              <PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fontSize: 10 }} />
              <Radar name="Percentile" dataKey="v" stroke="#6366F1" fill="#6366F1" fillOpacity={0.35} />
              <Tooltip formatter={(v) => [`${Math.round(v)}%`, "Percentile"]} />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

/* ---------- radial gauge ---------- */
function Gauge({ title, data, help }) {
  const v = data?.[0]?.value ?? 0;
  return (
    <div className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800" title={help}>
      <div className="mb-1 flex items-center justify-between text-sm font-semibold">
        <span>{title}</span>
        {help ? <HelpHint text={help} /> : null}
      </div>
      <div className="relative h-40">
        <ResponsiveContainer>
          <RadialBarChart innerRadius="70%" outerRadius="100%" data={data} startAngle={90} endAngle={-270}>
            <RadialBar dataKey="value" minAngle={2} cornerRadius={8} fill="#10B981" clockWise />
          </RadialBarChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="text-center">
            <div className="text-2xl font-bold tabular-nums">{v}%</div>
            <div className="text-[10px] text-zinc-500">percentile</div>
          </div>
        </div>
      </div>
    </div>
  );
}

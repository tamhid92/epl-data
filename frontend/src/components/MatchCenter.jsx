import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip, Legend,
  PieChart, Pie, Cell,
} from "recharts";
import ModalFrame from "./ModalFrame"; // ← NEW: use shared modal frame

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
function fmtNum(n, d = 2) {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v.toFixed(d) : "0";
}
function fmtDateTimeISO(isoStr) {
  try {
    const dt = new Date(isoStr);
    const d = new Intl.DateTimeFormat(undefined, {
      year: "numeric", month: "short", day: "2-digit"
    }).format(dt);
    const t = new Intl.DateTimeFormat(undefined, {
      hour: "numeric", minute: "2-digit"
    }).format(dt);
    return `${d} • ${t}`;
  } catch {
    return isoStr;
  }
}
const minuteStr = (m) => (m == null ? "" : `${m}'`);
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

/**
 * MatchCenter
 * Props:
 *  - open: boolean
 *  - matchId: string | null
 *  - apiBase: string
 *  - onClose: () => void
 */
export default function MatchCenter({ open, matchId, apiBase, onClose }) {
  // Keep hook order stable: short-circuit before hooks if closed.
  if (!open) return null;

  const closeRef = useRef(null);

  const [info, setInfo] = useState(null);
  const [roster, setRoster] = useState([]);
  const [shots, setShots] = useState([]);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (open && closeRef.current) closeRef.current.focus();
  }, [open]);

  useEffect(() => {
    if (!apiBase || !matchId) return;
    const ci = new AbortController();
    const cr = new AbortController();
    const cs = new AbortController();
    (async () => {
      try {
        setLoading(true);
        setErr(null);
        const inf = await fetchJson(`${apiBase}/match/info/${matchId}`, { signal: ci.signal });
        setInfo(Array.isArray(inf) ? inf[0] : inf || null);

        const ros = await fetchJson(`${apiBase}/match/roster/${matchId}`, { signal: cr.signal });
        setRoster(Array.isArray(ros) ? ros : []);

        const sh = await fetchJson(`${apiBase}/match/shots/${matchId}`, { signal: cs.signal });
        setShots(Array.isArray(sh) ? sh : []);
      } catch (e) {
        if (e.name !== "AbortError") setErr(String(e));
      } finally {
        setLoading(false);
      }
    })();
    return () => { ci.abort(); cr.abort(); cs.abort(); };
  }, [apiBase, matchId]);

  const hName = info?.team_h ?? "";
  const aName = info?.team_a ?? "";
  const hGoals = Number(info?.home_goals ?? 0);
  const aGoals = Number(info?.away_goals ?? 0);

  const hStats = {
    xg: Number(info?.home_xg ?? 0),
    shots: Number(info?.home_shots ?? 0),
    sot: Number(info?.home_shots_on_target ?? 0),
    ppda: Number(info?.home_ppda ?? 0),
    deep: Number(info?.home_deep ?? 0),
  };
  const aStats = {
    xg: Number(info?.away_xg ?? 0),
    shots: Number(info?.away_shots ?? 0),
    sot: Number(info?.away_shots_on_target ?? 0),
    ppda: Number(info?.away_ppda ?? 0),
    deep: Number(info?.away_deep ?? 0),
  };

  const homeRoster = useMemo(
    () => roster.filter((r) => info && r.team_id === info.home_team_id).sort((a,b)=>a.position_order-b.position_order),
    [roster, info]
  );
  const awayRoster = useMemo(
    () => roster.filter((r) => info && r.team_id === info.away_team_id).sort((a,b)=>a.position_order-b.position_order),
    [roster, info]
  );

  /** --------- Scorers (incl. own goals & penalties) ---------- */
  const { homeGoalEvents, awayGoalEvents } = useMemo(() => {
    const home = [];
    const away = [];
    const ogByPlayerInShots = new Map();

    for (const s of shots || []) {
      const minute = Number(s.minute ?? 0);
      const teamSide = s.team_side; // "h" or "a"
      const isOwn = s.result === "OwnGoal";
      const isPen = (s.situation === "Penalty") || /pen/i.test(String(s.shot_type || ""));

      if (s.result === "Goal") {
        const name = isPen ? `${s.player} (pen)` : s.player; // ← NEW: mark penalties
        const ev = { minute, scorer: name, assist: s.player_assisted || null, pen: isPen };
        if (teamSide === "h") home.push(ev); else away.push(ev);
      } else if (isOwn) {
        ogByPlayerInShots.set(s.player, (ogByPlayerInShots.get(s.player) || 0) + 1);
        const ev = { minute, scorer: `OG (${s.player})`, assist: null, og: true };
        if (teamSide === "h") away.push(ev); else home.push(ev);
      }
    }

    // Fill any OGs recorded on roster but not present in shots feed
    for (const r of roster || []) {
      const og = Number(r.own_goals || 0);
      if (og > 0) {
        const had = ogByPlayerInShots.get(r.player) || 0;
        const add = Math.max(0, og - had);
        if (add > 0) {
          const ev = { minute: null, scorer: `OG (${r.player})`, assist: null, og: true };
          const opposite =
            info && r.team_id === info.home_team_id ? "away" :
            info && r.team_id === info.away_team_id ? "home" : null;
          if (opposite === "away") for (let i = 0; i < add; i++) away.push(ev);
          if (opposite === "home") for (let i = 0; i < add; i++) home.push(ev);
        }
      }
    }

    const sortByMinute = (a, b) => (a.minute ?? 1e9) - (b.minute ?? 1e9);
    home.sort(sortByMinute); away.sort(sortByMinute);
    return { homeGoalEvents: home, awayGoalEvents: away };
  }, [shots, roster, info]);

  /* ---------- Derived for pills & charts ---------- */
  const maxShots = Math.max(1, hStats.shots, aStats.shots);
  const maxXg = Math.max(1e-6, hStats.xg, aStats.xg);
  const deepTotal = Math.max(1, hStats.deep + aStats.deep); // ← for "share" scaling

  return (
    <ModalFrame open={open} onClose={onClose} maxWidth="max-w-6xl">
      {/* top bar (kept minimal; scoreboard is below) */}
      <div className="flex items-center justify-end border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <button
          ref={closeRef}
          onClick={onClose}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
        >
          Close
        </button>
      </div>

      <div className="mx-auto w-full max-w-6xl grow min-h-0 overflow-y-auto px-4 py-5 md:px-6">
        {loading && <p className="text-sm text-zinc-500">Loading match…</p>}
        {err && <p className="text-sm text-rose-600">Failed to load match.</p>}

        {info && (
          <>
            {/* ===== Scoreboard with logos + scorers/assists ===== */}
            <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-6">
                {/* Home */}
                <div className="flex flex-col items-center">
                  <img
                    src={logoUrl(hName)}
                    alt={`${hName} logo`}
                    className="h-16 w-16 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
                    onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
                  />
                  <div className="mt-1 text-sm font-semibold">{hName}</div>
                </div>

                {/* Score */}
                <div className="px-2 text-center">
                  <div className="tabular-nums text-4xl font-extrabold leading-none">
                    {hGoals} — {aGoals}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    {info.league} • {fmtDateTimeISO(info.date_utc)}
                  </div>
                </div>

                {/* Away */}
                <div className="flex flex-col items-center">
                  <img
                    src={logoUrl(aName)}
                    alt={`${aName} logo`}
                    className="h-16 w-16 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
                    onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
                  />
                  <div className="mt-1 text-sm font-semibold">{aName}</div>
                </div>
              </div>

              {/* Scorers (spaced out more) */}
              <div className="mt-6 grid grid-cols-1 gap-10 md:grid-cols-2">
                <ScorersList align="right" title={`${hName} scorers`} items={homeGoalEvents} />
                <ScorersList align="left" title={`${aName} scorers`} items={awayGoalEvents} />
              </div>
            </section>

            {/* ===== Combined team comparison (ALL pills in one card) ===== */}
            <section className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div className="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
                <div className="mb-3 text-sm font-semibold">Team Comparison</div>

                <MirrorPillRow
                  label="Expected Goals (xG)"
                  home={{ label: hName, value: hStats.xg }}
                  away={{ label: aName, value: aStats.xg }}
                  max={maxXg}
                  valueFmt={(v) => fmtNum(v, 2)}
                />

                <div className="my-3 h-px w-full bg-zinc-200 dark:bg-zinc-800" />

                <MirrorPillRow
                  label="Shots (SOT)"
                  home={{ label: hName, value: hStats.shots, subValue: hStats.sot }}
                  away={{ label: aName, value: aStats.shots, subValue: aStats.sot }}
                  max={maxShots}
                  suffixHome={`${hStats.shots} (${hStats.sot} SOT)`}
                  suffixAway={`${aStats.shots} (${aStats.sot} SOT)`}
                />

                <div className="my-3 h-px w-full bg-zinc-200 dark:bg-zinc-800" />

                {/* NEW: Deep completion share — visually identical pill treatment */}
                <MirrorPillRow
                  label="Deep Completions (share)"
                  home={{ label: hName, value: hStats.deep }}
                  away={{ label: aName, value: aStats.deep }}
                  max={deepTotal} // scale by total → the bar widths reflect share
                  suffixHome={`${hStats.deep} (${fmtNum((hStats.deep / deepTotal) * 100, 0)}%)`}
                  suffixAway={`${aStats.deep} (${fmtNum((aStats.deep / deepTotal) * 100, 0)}%)`}
                />
                <p className="mt-1 text-xs text-zinc-500">
                  Deep completions ≈ final-third/box entries. Higher share suggests greater territorial pressure.
                </p>
              </div>

              {/* PPDA (new “dumbbell” visual) */}
              <div className="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
                <div className="mb-2 text-sm font-semibold">Pressing & Territory</div>

                <PPDADumbbell
                  home={{ name: hName, value: hStats.ppda }}
                  away={{ name: aName, value: aStats.ppda }}
                  max={30}
                />
                <p className="mt-1 text-xs text-zinc-500">
                  <strong>PPDA</strong> = Passes allowed Per Defensive Action (defensive intensity). Lower values indicate stronger pressing.
                </p>
              </div>
            </section>

            {/* ===== Shots & Visuals ===== */}
            <ShotsAndVisuals shots={shots} hName={hName} aName={aName} />

            {/* ===== Rosters ===== */}
            <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <RosterTable teamName={hName} rows={homeRoster} />
              <RosterTable teamName={aName} rows={awayRoster} />
            </div>
          </>
        )}
      </div>
    </ModalFrame>
  );
}

/* ================== Scorers list ================== */
function ScorersList({ title, items, align = "left" }) {
  const alignCls =
    align === "right" ? "items-end text-right" :
    align === "center" ? "items-center text-center" :
    "items-start text-left";

  return (
    <div className={`flex flex-col ${alignCls}`}>
      <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </div>
      {items.length === 0 ? (
        <div className="mt-2 text-sm text-zinc-500">—</div>
      ) : (
        <ul className="mt-2 space-y-4 text-sm">{/* ← more spacing */}
          {items.map((g, idx) => (
            <li key={`${g.scorer}-${g.minute ?? "x"}-${idx}`} className="leading-tight">
              <span className={`rounded-full px-2 py-0.5 font-medium ${
                g.og
                  ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                  : "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
              }`}>
                {g.scorer}
              </span>
              {g.minute != null && <span className="ml-2 text-xs text-zinc-500">{minuteStr(g.minute)}</span>}
              {!g.og && g.assist && (
                <span className="ml-2 text-xs text-zinc-500">(assist: {g.assist})</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ================== Colors & tiny bits ================== */

const HOME_CLR = "#3B82F6"; // blue
const AWAY_CLR = "#EF4444"; // red
const GOAL_STROKE = "#F59E0B";

/* ================== Mirror Pill Rows ================== */
/** One row: centered pill, left fill = home, right fill = away. Supports optional subValue overlay (e.g., SOT). */
function MirrorPillRow({
  label,
  home, // {label, value, subValue?}
  away, // {label, value, subValue?}
  max = 1,
  valueFmt = (v) => v,
  suffixHome,
  suffixAway,
}) {
  const leftPct = clamp((home.value ?? 0) / Math.max(max, 1)) * 50; // half scale
  const rightPct = clamp((away.value ?? 0) / Math.max(max, 1)) * 50;

  const leftSubPct = home.subValue != null ? clamp((home.subValue ?? 0) / Math.max(max, 1)) * 50 : null;
  const rightSubPct = away.subValue != null ? clamp((away.subValue ?? 0) / Math.max(max, 1)) * 50 : null;

  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-xs text-zinc-600 dark:text-zinc-300">
          {home.label}: {suffixHome ?? valueFmt(home.value)} &nbsp;|&nbsp; {away.label}: {suffixAway ?? valueFmt(away.value)}
        </span>
      </div>
      <div className="relative h-5 w-full rounded-full bg-zinc-200 dark:bg-zinc-800">
        {/* center divider */}
        <div className="absolute left-1/2 top-0 h-full w-[2px] -translate-x-1/2 bg-white/70 dark:bg-black/40" />

        {/* left (home) */}
        <div
          className="absolute right-1/2 top-0 h-full rounded-l-full"
          style={{ width: `${leftPct}%`, backgroundColor: HOME_CLR, opacity: 0.9 }}
          aria-label={`${home.label} ${label}`}
        />
        {/* right (away) */}
        <div
          className="absolute left-1/2 top-0 h-full rounded-r-full"
          style={{ width: `${rightPct}%`, backgroundColor: AWAY_CLR, opacity: 0.9 }}
          aria-label={`${away.label} ${label}`}
        />

        {/* Optional inner overlays for subValue (e.g., SOT) */}
        {leftSubPct != null && (
          <div
            className="absolute right-1/2 top-[3px] h-[14px] rounded-l-full"
            style={{ width: `${leftSubPct}%`, background: "rgba(255,255,255,0.9)" }}
          />
        )}
        {rightSubPct != null && (
          <div
            className="absolute left-1/2 top-[3px] h-[14px] rounded-r-full"
            style={{ width: `${rightSubPct}%`, background: "rgba(255,255,255,0.9)" }}
          />
        )}
      </div>
    </div>
  );
}

/* ================== PPDA Dumbbell ================== */
/** Simple, readable dumbbell with two markers on the same axis. */
function PPDADumbbell({ home, away, max = 30 }) {
  const axisTicks = [0, max / 3, (2 * max) / 3, max];
  const pos = (v) => `${clamp((v ?? 0) / Math.max(max, 1)) * 100}%`;

  return (
    <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">PPDA (lower is better)</div>
      <div className="relative mt-3 h-10">
        {/* axis */}
        <div className="absolute left-0 right-0 top-1/2 h-[3px] -translate-y-1/2 rounded bg-zinc-200 dark:bg-zinc-800" />
        {/* connection line */}
        <div
          className="absolute top-1/2 h-[3px] -translate-y-1/2 bg-zinc-400/70 dark:bg-zinc-600/70"
          style={{
            left: `min(${pos(home.value)}, ${pos(away.value)})`,
            width: `calc(max(${pos(home.value)}, ${pos(away.value)}) - min(${pos(home.value)}, ${pos(away.value)}))`,
          }}
        />
        {/* home dot */}
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full ring-2 ring-white dark:ring-black"
          style={{ left: pos(home.value), width: 14, height: 14, backgroundColor: HOME_CLR }}
          title={`${home.name}: PPDA ${fmtNum(home.value, 1)}`}
        />
        {/* away dot */}
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full ring-2 ring-white dark:ring-black"
          style={{ left: pos(away.value), width: 14, height: 14, backgroundColor: AWAY_CLR }}
          title={`${away.name}: PPDA ${fmtNum(away.value, 1)}`}
        />
        {/* tick labels */}
        <div className="absolute -top-5 left-0 right-0 flex justify-between text-[11px] text-zinc-500">
          {axisTicks.map((t) => <span key={t} className="tabular-nums">{fmtNum(t, 0)}</span>)}
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <div className="flex items-center gap-2"><Swatch c={HOME_CLR} />{home.name}: <span className="tabular-nums">{fmtNum(home.value,1)}</span></div>
        <div className="flex items-center gap-2 justify-end"><Swatch c={AWAY_CLR} />{away.name}: <span className="tabular-nums">{fmtNum(away.value,1)}</span></div>
      </div>
    </div>
  );
}

/* ================== Shots & Visuals ================== */

function ShotsAndVisuals({ shots, hName, aName }) {
  const [showHome, setShowHome] = useState(true);
  const [showAway, setShowAway] = useState(true);
  const [goalsOnly, setGoalsOnly] = useState(false);

  const { hShots, aShots, maxMin } = useMemo(() => {
    const hs = [];
    const as = [];
    let mm = 0;
    for (const s of shots || []) {
      const m = Number(s.minute ?? 0);
      mm = Math.max(mm, m);
      if (s.team_side === "h") hs.push(s);
      else as.push(s);
    }
    return { hShots: hs, aShots: as, maxMin: Math.max(mm, 95) };
  }, [shots]);

  const filteredH = useMemo(
    () => (showHome ? hShots.filter((s) => !goalsOnly || s.result === "Goal") : []),
    [hShots, showHome, goalsOnly]
  );
  const filteredA = useMemo(
    () => (showAway ? aShots.filter((s) => !goalsOnly || s.result === "Goal") : []),
    [aShots, showAway, goalsOnly]
  );

  // Cumulative xG timeline
  const timeline = useMemo(() => {
    const mk = (arr) =>
      [...arr]
        .sort((a, b) => Number(a.minute) - Number(b.minute))
        .reduce((acc, s) => {
          const minute = Number(s.minute ?? 0);
          const prev = acc.length ? acc[acc.length - 1].val : 0;
          acc.push({ minute, val: prev + Number(s.xG ?? 0) });
          return acc;
        }, []);
    const H = mk(hShots);
    const A = mk(aShots);
    const minSet = new Set([0, ...H.map((d) => d.minute), ...A.map((d) => d.minute), maxMin]);
    const xs = [...minSet].sort((a, b) => a - b);

    const lastOr0 = (arr, m) => {
      let v = 0;
      for (const d of arr) if (d.minute <= m) v = d.val;
      return v;
    };
    return xs.map((m) => ({
      minute: m,
      home: lastOr0(H, m),
      away: lastOr0(A, m),
    }));
  }, [hShots, aShots, maxMin]);

  // Donuts: xG by SITUATION
  const pieHome = useMemo(
    () => sumBy(hShots, (s) => s.situation || "Other", (s) => Number(s.xG || 0)),
    [hShots]
  );
  const pieAway = useMemo(
    () => sumBy(aShots, (s) => s.situation || "Other", (s) => Number(s.xG || 0)),
    [aShots]
  );
  const PIE_COLORS = ["#6366F1","#10B981","#F59E0B","#EC4899","#22D3EE","#84CC16","#8B5CF6","#14B8A6"];

  return (
    <section className="mt-8 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Shots & Visuals</h3>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={showHome} onChange={(e) => setShowHome(e.target.checked)} />
            <span className="flex items-center gap-1"><Swatch c={HOME_CLR} /> Home</span>
          </label>
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={showAway} onChange={(e) => setShowAway(e.target.checked)} />
            <span className="flex items-center gap-1"><Swatch c={AWAY_CLR} /> Away</span>
          </label>
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={goalsOnly} onChange={(e) => setGoalsOnly(e.target.checked)} />
            Goals only
          </label>
        </div>
      </div>

      {/* Shot map (with rich HTML tooltip) */}
      <div className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800">
        <div className="mb-2 text-xs text-zinc-500">
          Attacking from left → right (both teams plotted in the same direction). Marker size ∝ xG. Gold ring marks goals.
        </div>
        <ShotMap homeShots={filteredH} awayShots={filteredA} width={860} height={540} />
      </div>

      {/* Cumulative xG timeline + donuts (xG by situation) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="mb-2 text-sm font-semibold">Cumulative xG by Minute</div>
          <div className="h-64">
            <ResponsiveContainer>
              <LineChart data={timeline} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="minute" tick={{ fontSize: 12 }} label={{ value: "Minute", position: "insideBottomRight", offset: -5 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <ReTooltip formatter={(v) => (typeof v === "number" ? v.toFixed(2) : v)} />
                <Legend />
                <Line type="monotone" dataKey="home" name={hName} stroke={HOME_CLR} strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="away" name={aName} stroke={AWAY_CLR} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="mb-2 text-sm font-semibold">{hName}: xG by Situation</div>
            <div className="h-60">
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={pieHome} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="90%" paddingAngle={2}>
                    {pieHome.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  {/* ← NEW: tooltip with xG & share */}
                  <ReTooltip
                    formatter={(v, name, { payload, percent }) => [
                      `${fmtNum(v,2)} xG (${fmtNum((percent || 0)*100,0)}%)`,
                      name
                    ]}
                  />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="mb-2 text-sm font-semibold">{aName}: xG by Situation</div>
            <div className="h-60">
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={pieAway} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="90%" paddingAngle={2}>
                    {pieAway.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  {/* ← NEW: tooltip with xG & share */}
                  <ReTooltip
                    formatter={(v, name, { payload, percent }) => [
                      `${fmtNum(v,2)} xG (${fmtNum((percent || 0)*100,0)}%)`,
                      name
                    ]}
                  />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Swatch({ c }) {
  return <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: c }} />;
}

function sumBy(arr, keyFn, valFn) {
  const map = new Map();
  for (const x of arr || []) {
    const k = keyFn(x);
    const v = valFn(x);
    map.set(k, (map.get(k) || 0) + v);
  }
  return [...map.entries()].map(([name, value]) => ({ name, value }));
}

/* ---------- Shot Map (SVG + HTML Tooltip) ---------- */
function ShotMap({ homeShots, awayShots, width = 860, height = 540 }) {
  const wrapRef = useRef(null);
  const [tip, setTip] = useState(null); // {x,y, data}

  const toPx = (X, Y, isAway) => {
    const xx = isAway ? (1 - Number(X || 0)) : Number(X || 0);
    const yy = 1 - Number(Y || 0);
    return { x: xx * width, y: yy * height };
  };

  const items = [];
  for (const s of homeShots) {
    const { x, y } = toPx(s.X, s.Y, false);
    items.push({ ...s, x, y, color: HOME_CLR });
  }
  for (const s of awayShots) {
    const { x, y } = toPx(s.X, s.Y, true);
    items.push({ ...s, x, y, color: AWAY_CLR });
  }

  const rFor = (xg) => 4 + Math.min(14, Math.sqrt(Math.max(0, Number(xg || 0))) * 18);

  const onEnter = (e, d) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    setTip({
      x: (e.clientX - (rect?.left || 0)) + 12,
      y: (e.clientY - (rect?.top || 0)) + 12,
      data: d,
    });
  };
  const onMove = (e) => {
    if (!tip) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    setTip((t) => t && { ...t, x: (e.clientX - (rect?.left || 0)) + 12, y: (e.clientY - (rect?.top || 0)) + 12 });
  };
  const onLeave = () => setTip(null);

  return (
    <div ref={wrapRef} className="relative w-full overflow-hidden rounded-xl bg-[#14532D] ring-1 ring-zinc-200 dark:ring-zinc-800">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="auto" preserveAspectRatio="xMidYMid meet" onMouseMove={onMove}>
        <PitchLines w={width} h={height} />
        {items.map((s) => {
          const isGoal = s.result === "Goal";
          const r = rFor(s.xG);
          return (
            <g key={s.shot_id ?? `${s.team_side}-${s.minute}-${s.player}-${s.xG}`}>
              {isGoal && (
                <circle cx={s.x} cy={s.y} r={r + 3.5} fill="none" stroke={GOAL_STROKE} strokeWidth="3" opacity="0.95" />
              )}
              <circle
                cx={s.x}
                cy={s.y}
                r={r}
                fill={s.color}
                fillOpacity={0.65}
                stroke="white"
                strokeWidth="1.5"
                onMouseEnter={(e) => onEnter(e, s)}
                onMouseLeave={onLeave}
              />
            </g>
          );
        })}
      </svg>

      {/* legend */}
      <div className="flex items-center gap-4 p-2 text-xs text-white/90">
        <div className="flex items-center gap-2">
          <Swatch c={HOME_CLR} /> Home
        </div>
        <div className="flex items-center gap-2">
          <Swatch c={AWAY_CLR} /> Away
        </div>
        <div className="ml-auto flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-full ring-2 ring-[--g]" style={{ ["--g"]: GOAL_STROKE }} />
          <span>Goal ring</span>
        </div>
      </div>

      {/* tooltip */}
      {tip && (
        <div
          className="pointer-events-none absolute z-10 max-w-xs rounded-lg border border-zinc-200 bg-white/95 p-2 text-xs shadow-lg backdrop-blur-sm dark:border-zinc-700 dark:bg-zinc-900/95"
          style={{ left: tip.x, top: tip.y }}
        >
          <div className="font-medium">{tip.data.player}</div>
          <div className="mt-0.5 tabular-nums">
            {minuteStr(tip.data.minute)} • xG {fmtNum(tip.data.xG)} • {tip.data.result}
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-500">{tip.data.situation} • {tip.data.shot_type}</div>
        </div>
      )}
    </div>
  );
}

function PitchLines({ w, h }) {
  const line = { stroke: "white", strokeWidth: 2, opacity: 0.9 };
  const boxW = w * 0.165, sixW = w * 0.055, boxH = h * 0.63, sixH = h * 0.36;
  const penaltySpotX = w * 0.12;

  return (
    <>
      <rect x="1" y="1" width={w - 2} height={h - 2} rx="8" {...line} />
      <line x1={w / 2} y1={0} x2={w / 2} y2={h} {...line} />
      <circle cx={w / 2} cy={h / 2} r={h * 0.15} {...line} fill="none" />
      <circle cx={w / 2} cy={h / 2} r={3} fill="white" />

      {/* Left penalty area */}
      <rect x="0" y={(h - boxH) / 2} width={boxW} height={boxH} {...line} fill="none" />
      <rect x="0" y={(h - sixH) / 2} width={sixW} height={sixH} {...line} fill="none" />
      <circle cx={penaltySpotX} cy={h / 2} r={3} fill="white" />

      {/* Right penalty area (mirror) */}
      <rect x={w - boxW} y={(h - boxH) / 2} width={boxW} height={boxH} {...line} fill="none" />
      <rect x={w - sixW} y={(h - sixH) / 2} width={sixW} height={sixH} {...line} />
      <circle cx={w - penaltySpotX} cy={h / 2} r={3} fill="white" />
    </>
  );
}

/* ================== Simple UI bits (roster) ================== */

function RosterTable({ teamName, rows }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50/70 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
        <img
          src={logoUrl(teamName)}
          alt=""
          className="h-5 w-5 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
          onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
        />
        <div className="text-sm font-semibold">{teamName} Lineup</div>
      </div>
      <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
        <thead>
          <tr className="text-xs uppercase tracking-wider text-zinc-600 dark:text-zinc-300">
            <th className="px-3 py-2 text-left">Player</th>
            <th className="px-2 py-2 text-center">Pos</th>
            <th className="px-2 py-2 text-center">Min</th>
            <th className="px-2 py-2 text-center">G</th>
            <th className="px-2 py-2 text-center">A</th>
            <th className="px-2 py-2 text-center">Sh</th>
            <th className="px-2 py-2 text-center">KP</th>
            <th className="px-2 py-2 text-center">xG</th>
            <th className="px-2 py-2 text-center">xA</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 bg-white dark:divide-zinc-800 dark:bg-zinc-950">
          {rows.map((r) => (
            <tr key={r.appearance_id}>
              <td className="px-3 py-2 font-medium">{r.player}</td>
              <td className="px-2 py-2 text-center">{r.position}</td>
              <td className="px-2 py-2 text-center">{r.time_played}</td>
              <td className="px-2 py-2 text-center">{r.goals}</td>
              <td className="px-2 py-2 text-center">{r.assists}</td>
              <td className="px-2 py-2 text-center">{r.shots}</td>
              <td className="px-2 py-2 text-center">{r.key_passes}</td>
              <td className="px-2 py-2 text-center">{fmtNum(r.xG)}</td>
              <td className="px-2 py-2 text-center">{fmtNum(r.xA)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

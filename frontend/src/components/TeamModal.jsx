// components/TeamModal.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ResponsiveContainer,
  PieChart, Pie, Cell,
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
} from "recharts";
import ModalFrame from "./ModalFrame";

const API_TOKEN = import.meta.env.VITE_API_TOKEN;

/* ---------------- Utilities ---------------- */

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

// Treat API "YYYY-MM-DD HH:mm:ss" as UTC -> local Date
function parseUtcToLocal(utcStr) {
  const iso = utcStr.replace(" ", "T") + "Z";
  return new Date(iso);
}
function fmtDate(dt) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
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
const safeDiv = (n, d) => (d ? n / d : 0);
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

// chart palette (doesn't change tag/font colours)
const COLORS = ["#6366F1","#F59E0B","#10B981","#EF4444","#3B82F6","#8B5CF6","#EC4899","#22D3EE","#84CC16","#14B8A6"];

/* ---------------- Team brand colours (for gradient) ---------------- */

const TEAM_COLORS = {
  "Arsenal": "#EF4444",
  "Aston Villa": "#7C3AED",
  "Bournemouth": "#EF4444",
  "Brentford": "#EF4444",
  "Brighton": "#0EA5E9",
  "Burnley": "#9333EA",
  "Chelsea": "#2563EB",
  "Crystal Palace": "#0EA5E9",
  "Everton": "#1D4ED8",
  "Fulham": "#111827",
  "Leeds": "#2563EB",
  "Liverpool": "#DC2626",
  "Manchester City": "#38BDF8",
  "Manchester United": "#DC2626",
  "Newcastle United": "#111827",
  "Nottingham Forest": "#DC2626",
  "Tottenham": "#111827",
  "West Ham": "#7C3AED",
  "Wolverhampton Wanderers": "#F59E0B",
  "Sunderland": "#DC2626",
};

// hex → rgba
function hexToRgba(hex, a = 1) {
  const h = hex?.replace?.("#", "") ?? "";
  if (h.length !== 6) return `rgba(59,130,246,${a})`; // fallback sky-500
  const r = parseInt(h.slice(0,2), 16);
  const g = parseInt(h.slice(2,4), 16);
  const b = parseInt(h.slice(4,6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * TeamModal
 * Props:
 *  - open: boolean
 *  - team?: object (optional if opening by name)
 *  - teamName?: string (optional if `team` provided)
 *  - apiBase: string
 *  - standingsEndpoint: string
 *  - onClose: () => void
 *  - onOpenMatch?: (matchId: string) => void
 *  - onOpenPlayer?: (teamName: string, playerObj: object) => void
 *  - teamColors?: Record<string, string>   // optional: override/extend TEAM_COLORS
 */
export default function TeamModal({
  open,
  team,
  teamName,
  apiBase,
  standingsEndpoint,
  onClose,
  onOpenMatch,
  onOpenPlayer,
  teamColors,
}) {
  // ✅ Early return FIRST to keep hooks order stable
  if (!open || (!team && !teamName)) return null;

  const closeRef = useRef(null);
  const [tab, setTab] = useState("dashboard");

  // Data for header stats (and rank) when opened by name
  const [basicTeam, setBasicTeam] = useState(null);

  // Tab data
  const [roster, setRoster] = useState([]);
  const [fixtures, setFixtures] = useState([]);

  // Dashboard datasets
  const [chances, setChances] = useState([]);
  const [conceded, setConceded] = useState([]);
  const [formations, setFormations] = useState([]);

  // Shots (for heatmap)
  const [shotsRaw, setShotsRaw] = useState([]);
  const [loadingShots, setLoadingShots] = useState(false);
  const [errorShots, setErrorShots] = useState(null);

  /* ---------- team recents ---------- */
  const [teamRecents, setTeamRecents] = useState([]);
  const [loadingRecents, setLoadingRecents] = useState(false);
  const [errorRecents, setErrorRecents] = useState(null);

  // Loading / error
  const [loadingRoster, setLoadingRoster] = useState(false);
  const [loadingFixtures, setLoadingFixtures] = useState(false);
  const [errorRoster, setErrorRoster] = useState(null);
  const [errorFixtures, setErrorFixtures] = useState(null);

  const [loadingChances, setLoadingChances] = useState(false);
  const [errorChances, setErrorChances] = useState(null);

  const [loadingConceded, setLoadingConceded] = useState(false);
  const [errorConceded, setErrorConceded] = useState(null);

  const [loadingFormations, setLoadingFormations] = useState(false);
  const [errorFormations, setErrorFormations] = useState(null);

  // Focus & ESC to close
  useEffect(() => {
    if (open && closeRef.current) closeRef.current.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    // const onKey = (e) => e.key === "Escape" && onClose?.();
    const onKey = (e) => {
      if (e.key === "Escape") {
        try { history.back(); } catch { onClose?.(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Header basics + rank
  useEffect(() => {
    if (!open || !teamName || !standingsEndpoint) return;

    const ctrl = new AbortController();
    (async () => {
      try {
        const raw = await fetchJson(standingsEndpoint, { signal: ctrl.signal });
        const data = Array.isArray(raw) ? raw : [];

        const rows = data.map((r) => {
          const GF = +r.G || 0;
          const GA = +r.GA || 0;
          const GD = GF - GA;
          return {
            Team: r.Team,
            MP: +r.M || 0,
            W: +r.W || 0,
            D: +r.D || 0,
            L: +r.L || 0,
            GF,
            GA,
            GD,
            Pts: +r.PTS || 0,
            xG: +r.xG || 0,
          };
        });
        rows.sort((a, b) => b.Pts - a.Pts || b.GD - a.GD || b.GF - a.GF);
        rows.forEach((r, i) => (r.Pos = i + 1));

        const row = rows.find((r) => r.Team === teamName);
        setBasicTeam(row || { Team: teamName });
      } catch (e) {
        if (e.name !== "AbortError") {
          console.error(e);
          setBasicTeam({ Team: teamName });
        }
      }
    })();

    return () => ctrl.abort();
  }, [open, teamName, standingsEndpoint]);

  // Fetch all tab data
  useEffect(() => {
    if (!open || !apiBase) return;
    const t = team?.Team || teamName;
    if (!t) return;

    const ctrlRoster = new AbortController();
    const ctrlFix = new AbortController();
    const ctrlCh = new AbortController();
    const ctrlCc = new AbortController();
    const ctrlFm = new AbortController();
    const ctrlRc = new AbortController();
    const ctrlSh = new AbortController();

    (async () => {
      try {
        setLoadingRoster(true); setErrorRoster(null);
        const data = await fetchJson(`${apiBase}/${encodeURIComponent(t)}/squad`, { signal: ctrlRoster.signal });
        setRoster(Array.isArray(data) ? data : []);
      } catch (err) { if (err.name !== "AbortError") { console.error(err); setErrorRoster(String(err)); } }
      finally { setLoadingRoster(false); }
    })();

    (async () => {
      try {
        setLoadingFixtures(true); setErrorFixtures(null);
        const data = await fetchJson(`${apiBase}/fixtures/upcoming/${encodeURIComponent(t)}`, { signal: ctrlFix.signal });
        setFixtures(Array.isArray(data) ? data : []);
      } catch (err) { if (err.name !== "AbortError") { console.error(err); setErrorFixtures(String(err)); } }
      finally { setLoadingFixtures(false); }
    })();

    (async () => {
      try {
        setLoadingChances(true); setErrorChances(null);
        const data = await fetchJson(`${apiBase}/team_chances_created/${encodeURIComponent(t)}`, { signal: ctrlCh.signal });
        setChances(Array.isArray(data) ? data : []);
      } catch (err) { if (err.name !== "AbortError") { console.error(err); setErrorChances(String(err)); } }
      finally { setLoadingChances(false); }
    })();

    (async () => {
      try {
        setLoadingConceded(true); setErrorConceded(null);
        const data = await fetchJson(`${apiBase}/team_chances_conceded/${encodeURIComponent(t)}`, { signal: ctrlCc.signal });
        setConceded(Array.isArray(data) ? data : []);
      } catch (err) { if (err.name !== "AbortError") { console.error(err); setErrorConceded(String(err)); } }
      finally { setLoadingConceded(false); }
    })();

    (async () => {
      try {
        setLoadingFormations(true); setErrorFormations(null);
        const data = await fetchJson(`${apiBase}/formations/${encodeURIComponent(t)}`, { signal: ctrlFm.signal });
        setFormations(Array.isArray(data) ? data : []);
      } catch (err) { if (err.name !== "AbortError") { console.error(err); setErrorFormations(String(err)); } }
      finally { setLoadingFormations(false); }
    })();

    (async () => {
      try {
        setLoadingRecents(true); setErrorRecents(null);
        const data = await fetchJson(`${apiBase}/recents/${encodeURIComponent(t)}`, { signal: ctrlRc.signal });
        const list = Array.isArray(data) ? data : [];
        const mapped = list.map((m) => {
          const dt = parseUtcToLocal(m.datetime);
          return { id: String(m.id), dt, home: m.home_team, away: m.away_team, hg: Number(m.home_goals ?? 0), ag: Number(m.away_goals ?? 0), venue: m.venue || "" };
        }).sort((a, b) => b.dt - a.dt);
        setTeamRecents(mapped);
      } catch (err) { if (err.name !== "AbortError") { console.error(err); setErrorRecents(String(err)); } }
      finally { setLoadingRecents(false); }
    })();

    (async () => {
      try {
        setLoadingShots(true); setErrorShots(null);
        const data = await fetchJson(`${apiBase}/shots/${encodeURIComponent(t)}`, { signal: ctrlSh.signal });
        setShotsRaw(Array.isArray(data) ? data : []);
      } catch (err) { if (err.name !== "AbortError") { console.error(err); setErrorShots(String(err)); } }
      finally { setLoadingShots(false); }
    })();

    return () => {
      ctrlRoster.abort(); ctrlFix.abort(); ctrlCh.abort(); ctrlCc.abort(); ctrlFm.abort(); ctrlRc.abort(); ctrlSh.abort();
    };
  }, [open, apiBase, team, teamName]);

  const base = team || basicTeam || { Team: teamName };
  const {
    Team,
    MP = 0,
    W = 0,
    D = 0,
    L = 0,
    GF = 0,
    GA = 0,
    GD = (GF || 0) - (GA || 0),
    Pts = 0,
    xG = 0,
    Pos,
  } = base;

  // Derived
  const ppm = safeDiv(Pts, MP);
  const gf90 = safeDiv(GF, MP);
  const ga90 = safeDiv(GA, MP);
  const xg90 = safeDiv(+xG || 0, MP);

  // 🎨 Team gradient background (starts at top-left → bottom-right)
  const colorMap = { ...TEAM_COLORS, ...(teamColors || {}) };
  const accentHex = colorMap[Team] || "#3B82F6";
  const gradientCss = `linear-gradient(to bottom right, ${hexToRgba(accentHex, 0.16)} 0%, rgba(0,0,0,0) 55%)`;

  return (
    <ModalFrame open={open} onClose={onClose} maxWidth="max-w-6xl">
      {/* Wrapper gets the background image; no absolute overlays, so scrolling works */}
      <div
        className="rounded-2xl flex max-h-[85vh] flex-col overflow-hidden"
        style={{ backgroundImage: gradientCss, backgroundRepeat: "no-repeat" }}
      >
        {/* Header */}
        <div className="flex flex-none items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="flex items-center gap-3">
            <img
              src={logoUrl(Team)}
              alt={`${Team} logo`}
              className="h-10 w-10 rounded-full bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
              onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
            />
            <div>
              <h2 id="team-modal-title" className="text-xl font-semibold tracking-tight">{Team}</h2>
              {typeof Pos === "number" && (
                <div className="text-xs text-zinc-500 dark:text-zinc-400">Current rank: #{Pos}</div>
              )}
            </div>
          </div>
          <button
            ref={closeRef}
            onClick={() => { try { history.back(); } catch { onClose?.(); } }}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            Close
          </button>
        </div>

        {/* Tabs */}
        <div className="mx-auto mt-2 w-full max-w-6xl px-4 md:px-6 flex-none">
          <div className="flex gap-2 border-b border-zinc-200 dark:border-zinc-800">
            <TabButton active={tab === "dashboard"} onClick={() => setTab("dashboard")}>Dashboard</TabButton>
            <TabButton active={tab === "roster"} onClick={() => setTab("roster")}>Roster</TabButton>
            <TabButton active={tab === "fixtures"} onClick={() => setTab("fixtures")}>Fixtures</TabButton>
          </div>
        </div>

        {/* Content (scrolls within panel) */}
        <div
          className="mx-auto w-full max-w-6xl flex-1 min-h-0 overflow-y-auto px-4 py-5 md:px-6"
          style={{ WebkitOverflowScrolling: "touch" }}
        >
          {tab === "dashboard" && (
            <DashboardView
              base={{ Team, MP, W, D, L, GF, GA, GD, Pts, xG, Pos }}
              roster={roster}
              fixtures={fixtures}
              chances={chances}
              conceded={conceded}
              formations={formations}
              derived={{ ppm, gf90, ga90, xg90 }}
              teamRecents={teamRecents}
              loadingRecents={loadingRecents}
              errorRecents={errorRecents}
              onOpenMatch={onOpenMatch}
              shotsRaw={shotsRaw}
              loadingShots={loadingShots}
              errorShots={errorShots}
            />
          )}
          {tab === "roster" && (
            <RosterView
              loading={loadingRoster}
              error={errorRoster}
              roster={roster}
              teamName={Team}
              onSelectPlayer={(p) => onOpenPlayer?.(Team, p)}
            />
          )}
          {tab === "fixtures" && (
            <FixturesView loading={loadingFixtures} error={errorFixtures} fixtures={fixtures} />
          )}
        </div>
      </div>
    </ModalFrame>
  );
}

/* ---------------- UI Bits ---------------- */

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`relative px-3 py-2 text-sm font-medium ${
        active
          ? "text-zinc-900 dark:text-zinc-100"
          : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
      }`}
      aria-selected={active}
      role="tab"
    >
      {children}
      <span
        className={`absolute left-0 right-0 bottom-0 h-[2px] rounded ${
          active ? "bg-zinc-900 dark:bg-zinc-100" : "bg-transparent"
        }`}
      />
    </button>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{sub}</div>}
    </div>
  );
}

function Pill({ children, intent = "default" }) {
  const color =
    intent === "good" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
    : intent === "warn" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
    : intent === "bad"  ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
    : "bg-zinc-500/10 text-zinc-700 dark:text-zinc-300";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${color}`}>
      {children}
    </span>
  );
}

/* ---------------- Simple Bars (CSS) ---------------- */

function HBar({ value = 0, max = 1, label, suffix = "", className = "" }) {
  const pct = Math.max(0, Math.min(100, (value / Math.max(max, 1)) * 100));
  return (
    <div className={`w-full ${className}`}>
      <div className="mb-1 flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-300">
        <span>{label}</span>
        <span className="tabular-nums">{typeof value === "number" ? value.toFixed?.(2) ?? value : value}{suffix}</span>
      </div>
      <div className="h-3 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div className="h-full bg-sky-500/80" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ---------------- Dashboard ---------------- */

function MiniFixture({ f }) {
  return (
    <div className="rounded-xl border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
      <div className="flex items-center justify-between">
        <div className="font-medium">{f.home} vs {f.away}</div>
        <div className="text-xs tabular-nums text-zinc-500">{f.date} • {f.time}</div>
      </div>
      {f.venue && <div className="mt-0.5 text-xs text-zinc-500">{f.venue}</div>}
    </div>
  );
}

/* Recent/form helpers */
function resultLetter(m, teamName) {
  const isHome = m.home === teamName;
  const gf = isHome ? m.hg : m.ag;
  const ga = isHome ? m.ag : m.hg;
  if (gf > ga) return "W";
  if (gf < ga) return "L";
  return "D";
}
function opponentOf(m, teamName) {
  return m.home === teamName ? m.away : m.home;
}
function letterIntent(letter) {
  return letter === "W" ? "good" : letter === "L" ? "bad" : "default";
}

function DashboardView({
  base, roster, fixtures,
  chances, conceded, formations,
  derived,
  teamRecents, loadingRecents, errorRecents,
  onOpenMatch,
  shotsRaw, loadingShots, errorShots,
}) {
  const { Team, MP, W, D, L, GF, GA, GD, Pts, xG, Pos } = base;
  const { ppm, gf90, ga90, xg90 } = derived;

  // Next 3 fixtures
  const next3 = useMemo(() => {
    const list = Array.isArray(fixtures) ? fixtures : [];
    const mapped = list.map((f) => {
      const dt = parseUtcToLocal(f.datetime);
      return {
        id: String(f.id),
        home: f.home_team,
        away: f.away_team,
        date: fmtDate(dt),
        time: fmtTime(dt),
        venue: f.venue || "",
      };
    });
    return mapped.slice(0, 3);
  }, [fixtures]);

  // Chance creation by situation
  const situationRows = useMemo(() => {
    const arr = Array.isArray(chances) ? chances : [];
    const normalized = arr.map((r) => ({
      situation: r.situation || "Unknown",
      shots: +r.shots || 0,
      goals: +r.goals || 0,
      xg: +r.xG || 0,
    }));
    normalized.sort((a, b) => b.xg - a.xg || b.shots - a.shots);
    const maxXg = Math.max(1, ...normalized.map((r) => r.xg));
    const maxShots = Math.max(1, ...normalized.map((r) => r.shots));
    return { rows: normalized, maxXg, maxShots };
  }, [chances]);

  // Conceded by situation
  const concededRows = useMemo(() => {
    const arr = Array.isArray(conceded) ? conceded : [];
    const normalized = arr.map((r) => ({
      situation: r.situation || "Unknown",
      shots: +r.shots || 0,
      goals: +r.goals || 0,
      xg: +r.xG || 0,
    }));
    const maxXg = Math.max(1, ...normalized.map((r) => r.xg));
    const maxShots = Math.max(1, ...normalized.map((r) => r.shots));
    return { rows: normalized, maxXg, maxShots };
  }, [conceded]);

  // Overlay dataset
  const overlay = useMemo(() => {
    const map = new Map();
    situationRows.rows.forEach((r) => {
      map.set(r.situation, {
        situation: r.situation,
        shotsFor: r.shots,
        goalsFor: r.goals,
        xgFor: r.xg,
        shotsAgainst: 0,
        goalsAgainst: 0,
        xgAgainst: 0,
      });
    });
    concededRows.rows.forEach((r) => {
      const ex = map.get(r.situation) || {
        situation: r.situation,
        shotsFor: 0, goalsFor: 0, xgFor: 0,
        shotsAgainst: 0, goalsAgainst: 0, xgAgainst: 0,
      };
      ex.shotsAgainst = r.shots;
      ex.goalsAgainst = r.goals;
      ex.xgAgainst = r.xg;
      map.set(r.situation, ex);
    });

    const rows = Array.from(map.values());
    const data = rows.map((r) => ({
      situation: r.situation,
      shotsFor: r.shotsFor,
      shotsAgainstNeg: -r.shotsAgainst,
      xgFor: r.xgFor,
      xgAgainstNeg: -r.xgAgainst,
      goalsFor: r.goalsFor,
      goalsAgainstNeg: -r.goalsAgainst,
    }));

    const maxShots = Math.max(1, ...rows.map((r) => Math.max(r.shotsFor, r.shotsAgainst)));
    const maxXg = Math.max(1, ...rows.map((r) => Math.max(r.xgFor, r.xgAgainst)));

    const order = ["OpenPlay", "FromCorner", "SetPiece", "DirectFreekick", "Penalty"];
    data.sort((a, b) => {
      const ia = order.indexOf(a.situation);
      const ib = order.indexOf(b.situation);
      if (ia === -1 && ib === -1) return a.situation.localeCompare(b.situation);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });

    return { data, maxShots, maxXg, rows };
  }, [situationRows.rows, concededRows.rows]);

  // Radar data
  const radarData = useMemo(() => {
    const forMap = new Map(situationRows.rows.map(r => [r.situation, r.xg]));
    const agMap  = new Map(concededRows.rows.map(r => [r.situation, r.xg]));
    const all = new Set([...forMap.keys(), ...agMap.keys()]);
    const order = ["OpenPlay", "FromCorner", "SetPiece", "DirectFreekick", "Penalty"];
    const names = Array.from(all);
    names.sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });

    const maxXg = Math.max(
      1,
      ...names.map(n => Math.max(forMap.get(n) || 0, agMap.get(n) || 0))
    );

    return names.map(n => {
      const xgForAbs = forMap.get(n) || 0;
      const xgAgAbs  = agMap.get(n) || 0;
      return {
        situation: n,
        xgForPct: (xgForAbs / maxXg) * 100,
        xgAgainstPct: (xgAgAbs / maxXg) * 100,
        xgForAbs,
        xgAgainstAbs: xgAgAbs,
      };
    });
  }, [situationRows.rows, concededRows.rows]);

  // Donut data
  const pieData = useMemo(
    () => situationRows.rows.map((r) => ({ name: r.situation, value: r.xg })),
    [situationRows.rows]
  );

  // Recent & form
  const recentRows = Array.isArray(teamRecents) ? teamRecents : [];
  const last5 = useMemo(() => recentRows.slice(0, 5).reverse(), [recentRows]);
  const formGuide = useMemo(() => last5.map((m) => resultLetter(m, base.Team)), [last5, base.Team]);

  // Normalize shots into attacking half
  const shots = useMemo(() => {
    const arr = Array.isArray(shotsRaw) ? shotsRaw : [];
    return arr.map((s) => {
      const X = clamp01(s.X ?? s.x ?? 0);
      const Y = clamp01(s.Y ?? s.y ?? 0);
      const xG = Math.max(0, Number(s.xG ?? s.npxG ?? 0));
      const Xhalf = X >= 0.5 ? X : 1 - X;
      const xLocal = (Xhalf - 0.5) * 2;
      return { x: xLocal, y: Y, w: xG, result: s.result || "Shot" };
    });
  }, [shotsRaw]);

  const [showShotDots, setShowShotDots] = useState(false);

  return (
    <div className="space-y-8">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {typeof Pos === "number" && <StatCard label="League Position" value={`#${Pos}`} />}
        <StatCard label="Points" value={Pts} sub={`${ppm.toFixed(2)} / match`} />
        <StatCard label="Goals For" value={GF} sub={`${gf90.toFixed(2)} per match`} />
        <StatCard label="Goals Against" value={GA} sub={`${ga90.toFixed(2)} per match`} />
        <StatCard label="Goal Diff" value={GD > 0 ? `+${GD}` : GD} />
        <StatCard label="Cumulative xG" value={(+xG || 0).toFixed(2)} sub={`${xg90.toFixed(2)} per match`} />
        <StatCard label="W / D / L" value={`${W} / ${D} / ${L}`} />
        <StatCard label="Matches Played" value={MP} />
      </div>

      {/* Form Guide + Recent Results */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {/* Form Guide */}
        <div className="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Form Guide (last 5)</h3>
            {loadingRecents && <span className="text-xs text-zinc-500">Loading…</span>}
          </div>
          {errorRecents ? (
            <div className="text-sm text-rose-600">Failed to load recent results.</div>
          ) : last5.length === 0 ? (
            <div className="text-sm text-zinc-500">No recent results.</div>
          ) : (
            <div className="flex items-center gap-2">
              {formGuide.map((L, i) => (
                <div
                  key={i}
                  className={`grid h-10 w-10 place-items-center rounded-full text-sm font-bold ${
                    L === "W" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                    : L === "L" ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                    : "bg-zinc-500/10 text-zinc-700 dark:text-zinc-300"
                  }`}
                  title={L}
                >
                  {L}
                </div>
              ))}
            </div>
          )}
          {last5.length > 0 && (
            <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              Oldest on the left → newest on the right.
            </div>
          )}
        </div>

        {/* Recent Results strip */}
        <div className="md:col-span-2 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Recent Results</h3>
          </div>
          {errorRecents ? (
            <div className="text-sm text-rose-600">Failed to load results.</div>
          ) : recentRows.length === 0 ? (
            <div className="text-sm text-zinc-500">No recent matches.</div>
          ) : (
            <div className="flex gap-3 overflow-x-auto py-1">
              {recentRows.slice(0, 12).map((m) => {
                const L = resultLetter(m, base.Team);
                const opp = opponentOf(m, base.Team);
                const label = `${fmtDate(m.dt)} ${fmtTime(m.dt)} — ${m.home} ${m.hg}–${m.ag} ${m.away}`;
                return (
                  <button
                    key={m.id}
                    onClick={() => onOpenMatch?.(m.id)}
                    className="min-w-[210px] rounded-xl border border-zinc-200 px-3 py-2 text-left text-sm transition hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-zinc-800 dark:hover:bg-zinc-900"
                    title={label}
                    aria-label={`Open match: ${label}`}
                  >
                    <div className="mb-1 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <img
                          src={logoUrl(opp)}
                          alt=""
                          className="h-5 w-5 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
                          onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
                        />
                        <span className="font-medium">{opp}</span>
                      </div>
                      <Pill intent={letterIntent(L)}>{L}</Pill>
                    </div>
                    <div className="flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-300">
                      <span>{fmtDate(m.dt)}</span>
                      <span className="tabular-nums">
                        {m.home} {m.hg} — {m.ag} {m.away}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Overview bars */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <HBar label="xG vs GF (delta)" value={Math.max(GF - (+xG || 0), 0)} max={Math.max(GF, +xG || 0, 1)} />
        <HBar label="Goals For vs Against (GF share)" value={GF} max={GF + GA || 1} />
      </div>

      {/* Formations summary */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Formations Used</h3>
        </div>
        <div className="grid grid-cols-1 gap-3">
          {formations.map((f) => (
            <div key={f.formation} className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-medium">{f.formation}</div>
                <div className="flex items-center gap-2">
                  <Pill intent="default">{(+f.time || 0)}&prime; used</Pill>
                  <Pill intent="default">Shots {+f.shots || 0}</Pill>
                  <Pill intent="good">Goals {+f.goals || 0}</Pill>
                  <Pill intent="default">xG {(+f.xG || 0).toFixed(2)}</Pill>
                </div>
              </div>
              <HBar value={+f.time || 0} max={Math.max(1, ...formations.map(ff => +ff.time || 0))} label="Minutes on pitch" />
            </div>
          ))}
        </div>
      </section>

      {/* Created (donut) & Radar */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">xG Share by Situation (Created)</h3>
          </div>
          {pieData.length === 0 ? (
            <div className="text-sm text-zinc-500">No data.</div>
          ) : (
            <div className="h-64">
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="90%" paddingAngle={2}>
                    {pieData.map((entry, i) => (<Cell key={`slice-${i}`} fill={COLORS[i % COLORS.length]} />))}
                  </Pie>
                  <Tooltip formatter={(v) => v.toFixed ? v.toFixed(2) : v} />
                  <Legend verticalAlign="bottom" height={24} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Situational xG — Created vs Conceded (Radar)</h3>
          </div>
          {radarData.length === 0 ? (
            <div className="text-sm text-zinc-500">No data.</div>
          ) : (
            <div className="h-72">
              <ResponsiveContainer>
                <RadarChart data={radarData} outerRadius="75%">
                  <PolarGrid />
                  <PolarAngleAxis dataKey="situation" tick={{ fontSize: 12 }} />
                  <PolarRadiusAxis angle={30} tick={{ fontSize: 10 }} domain={[0, 100]} />
                  <Radar name="xG Created (norm)" dataKey="xgForPct" stroke="#10B981" fill="#10B981" fillOpacity={0.28} />
                  <Radar name="xG Conceded (norm)" dataKey="xgAgainstPct" stroke="#FB7185" fill="#FB7185" fillOpacity={0.22} />
                  <Legend />
                  <Tooltip
                    formatter={(v, name, { payload }) => {
                      const abs = name.includes("Created") ? payload.xgForAbs : payload.xgAgainstAbs;
                      return [`${Math.round(v)}% (xG ${abs.toFixed(2)})`, name];
                    }}
                  />
                </RadarChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            Normalized to the max xG across created+conceded so shapes are comparable.
          </div>
        </div>
      </section>

      {/* Attack vs Defence Overlay */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Attack vs Defence — Created vs Conceded (by Situation)</h3>
        </div>
        {overlay.data.length === 0 ? (
          <div className="text-sm text-zinc-500">No data.</div>
        ) : (
          <div className="h-80 rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800">
            <ResponsiveContainer>
              <ComposedChart data={overlay.data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="situation" tick={{ fontSize: 12 }} />
                <YAxis
                  yAxisId="left"
                  domain={[-overlay.maxShots, overlay.maxShots]}
                  tickFormatter={(v) => Math.abs(v)}
                  tick={{ fontSize: 12 }}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  domain={[-overlay.maxXg, overlay.maxXg]}
                  tickFormatter={(v) => Math.abs(v).toFixed(2)}
                  tick={{ fontSize: 12 }}
                />
                <Tooltip
                  formatter={(value, name) => {
                    const val = typeof value === "number" ? Math.abs(value) : value;
                    return [val, name];
                  }}
                />
                <Legend />
                <Bar yAxisId="left" dataKey="shotsFor" name="Shots For" fill="#3B82F6" radius={[4,4,0,0]} />
                <Bar yAxisId="left" dataKey="shotsAgainstNeg" name="Shots Against" fill="#EF4444" radius={[4,4,0,0]} />
                <Line yAxisId="right" type="monotone" dataKey="xgFor" name="xG For" stroke="#10B981" strokeWidth={2} dot={{ r: 2 }} />
                <Line yAxisId="right" type="monotone" dataKey="xgAgainstNeg" name="xG Against" stroke="#FB7185" strokeWidth={2} dot={{ r: 2 }} />
              </ComposedChart>
            </ResponsiveContainer>
            <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              Upward bars/lines = created (for). Downward = conceded (against). Axis labels show absolute values.
            </div>
          </div>
        )}
      </section>

      {/* Team Shot Heatmap */}
      <section>
        <div className="mb-2 flex items-center gap-3">
          <h3 className="text-sm font-semibold">Shot Heatmap (Attacking Half)</h3>
          <label className="ml-auto inline-flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
            <input
              type="checkbox"
              className="accent-sky-600"
              checked={showShotDots}
              onChange={(e) => setShowShotDots(e.target.checked)}
            />
            Show shots
          </label>
        </div>
        {errorShots ? (
          <div className="text-sm text-rose-600">Failed to load shots.</div>
        ) : loadingShots ? (
          <div className="text-sm text-zinc-500">Loading shots…</div>
        ) : (
          <div className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800">
            <HalfPitchHeatmap shots={shots} showDots={showShotDots} />
            <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              Intensity is weighted by cumulative xG per cell. Mirrored so the team always attacks → right.
            </div>
          </div>
        )}
      </section>

      {/* Upcoming fixtures snapshot */}
      <section>
        <div className="mb-2 text-sm font-semibold">Next Fixtures</div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          {next3.map((f) => <MiniFixture key={f.id} f={f} />)}
        </div>
      </section>
    </div>
  );
}

/* ---------------- Roster ---------------- */

function RosterView({ loading, error, roster, teamName, onSelectPlayer }) {
  const rows = useMemo(() => {
    const list = Array.isArray(roster) ? roster : [];
    return [...list].sort((a, b) => Number(b.time || 0) - Number(a.time || 0));
  }, [roster]);

  if (loading) return <p className="text-center text-sm text-zinc-600 dark:text-zinc-300">Loading roster…</p>;
  if (error) return <p className="text-center text-sm text-rose-600">Failed to load roster.</p>;
  if (!rows.length) return <p className="text-center text-sm text-zinc-500">No players found.</p>;

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800">
      <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
        <thead className="bg-zinc-50/70 dark:bg-zinc-900/60">
          <tr className="text-xs uppercase tracking-wider text-zinc-600 dark:text-zinc-300">
            <th className="px-3 py-2 text-left">Player</th>
            <th className="px-2 py-2 text-center">Pos</th>
            <th className="px-2 py-2 text-center">Apps</th>
            <th className="px-2 py-2 text-center">Min</th>
            <th className="px-2 py-2 text-center">G</th>
            <th className="px-2 py-2 text-center">A</th>
            <th className="px-2 py-2 text-center">Sh</th>
            <th className="px-2 py-2 text-center">KP</th>
            <th className="px-2 py-2 text-center">xG</th>
            <th className="px-2 py-2 text-center">xA</th>
            <th className="px-2 py-2 text-center">Y/R</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 bg-white dark:divide-zinc-800 dark:bg-zinc-950">
          {rows.map((p) => (
            <tr
              key={p.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelectPlayer?.(p)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelectPlayer?.(p)}
              className="cursor-pointer hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:bg-zinc-900"
              title={`Open ${p.player_name}`}
            >
              <td className="px-3 py-2 font-medium">{p.player_name}</td>
              <td className="px-2 py-2 text-center">{p.position}</td>
              <td className="px-2 py-2 text-center">{p.games}</td>
              <td className="px-2 py-2 text-center">{p.time}</td>
              <td className="px-2 py-2 text-center">{p.goals}</td>
              <td className="px-2 py-2 text-center">{p.assists}</td>
              <td className="px-2 py-2 text-center">{p.shots}</td>
              <td className="px-2 py-2 text-center">{p.key_passes}</td>
              <td className="px-2 py-2 text-center">{Number(p.xG || 0).toFixed(2)}</td>
              <td className="px-2 py-2 text-center">{Number(p.xA || 0).toFixed(2)}</td>
              <td className="px-2 py-2 text-center">
                {p.yellow_cards}/{p.red_cards}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- Fixtures ---------------- */

function FixturesView({ loading, error, fixtures }) {
  const rows = useMemo(() => {
    const list = Array.isArray(fixtures) ? fixtures : [];
    return list.map((f) => {
      const dt = parseUtcToLocal(f.datetime);
      return {
        id: String(f.id),
        home: f.home_team,
        away: f.away_team,
        date: fmtDate(dt),
        time: fmtTime(dt),
        venue: f.venue || "",
      };
    });
  }, [fixtures]);

  if (loading) return <p className="text-center text-sm text-zinc-600 dark:text-zinc-300">Loading fixtures…</p>;
  if (error) return <p className="text-center text-sm text-rose-600">Failed to load fixtures.</p>;
  if (!rows.length) return <p className="text-center text-sm text-zinc-500">No upcoming fixtures.</p>;

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800">
      <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
        <thead className="bg-zinc-50/70 dark:bg-zinc-900/60">
          <tr className="text-xs uppercase tracking-wider text-zinc-600 dark:text-zinc-300">
            <th className="px-3 py-2 text-left">Home</th>
            <th className="px-3 py-2 text-left">Away</th>
            <th className="px-2 py-2 text-center">Date</th>
            <th className="px-2 py-2 text-center">Time</th>
            <th className="px-3 py-2 text-left">Venue</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 bg-white dark:divide-zinc-800 dark:bg-zinc-950">
          {rows.map((m) => (
            <tr key={m.id}>
              <td className="px-3 py-2 font-medium">{m.home}</td>
              <td className="px-3 py-2">{m.away}</td>
              <td className="px-2 py-2 text-center">{m.date}</td>
              <td className="px-2 py-2 text-center tabular-nums">{m.time}</td>
              <td className="px-3 py-2">{m.venue}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- Heatmap (Half Pitch SVG, H = 50) ---------------- */

function HalfPitchHeatmap({ shots, showDots = false, cols = 24, rows = 16 }) {
  const { grid, max } = useMemo(() => {
    const g = Array.from({ length: rows }, () => Array(cols).fill(0));
    let mx = 0;
    for (const s of shots) {
      const cx = Math.min(cols - 1, Math.floor(clamp01(s.x) * cols));
      const ry = Math.min(rows - 1, Math.floor(clamp01(s.y) * rows));
      const val = Math.max(0, Number(s.w) || 0);
      g[ry][cx] += val;
      if (g[ry][cx] > mx) mx = g[ry][cx];
    }
    return { grid: g, max: mx || 1 };
  }, [shots, cols, rows]);

  // Geometry
  const W = 100;
  const H = 50;
  const cw = W / cols;
  const ch = H / rows;

  // Convert real-metre vertical distances (based on 68m) to our H=50 canvas
  const sy = (m) => (m * H) / 68;

  // Lines color
  const prefersDark = typeof window !== "undefined"
    && window.matchMedia
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const stroke = prefersDark ? "#3f3f46" : "#e4e4e7";

  // Heat alpha ramp
  const alpha = (t) => Math.max(0, Math.min(0.9, t));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
      <rect x="0" y="0" width={W} height={H} fill="transparent" />
      {grid.map((row, r) =>
        row.map((v, c) => {
          if (v <= 0) return null;
          const a = alpha(v / max);
          return (
            <rect
              key={`${r}-${c}`}
              x={c * cw}
              y={r * ch}
              width={cw}
              height={ch}
              fill={`rgba(239, 68, 68, ${a})`}
            />
          );
        })
      )}
      <rect x="0" y="0" width={W} height={H} fill="none" stroke={stroke} strokeWidth="0.6" />
      <rect x={W - 16.5} y={sy(16.5)} width={16.5} height={H - sy(33)} fill="none" stroke={stroke} strokeWidth="0.6" />
      <rect x={W - 5.5} y={(H - sy(18.32)) / 2} width={5.5} height={sy(18.32)} fill="none" stroke={stroke} strokeWidth="0.6" />
      <circle cx={W - 11} cy={H / 2} r="0.75" fill={stroke} />
      <path d={describeArc(W - 11, H / 2, sy(9.15), 310, 50)} fill="none" stroke={stroke} strokeWidth="0.6" />
      <line x1="0" y1={0} x2="0" y2={H} stroke={stroke} strokeWidth="0.6" />
      {showDots &&
        shots.map((s, i) => {
          const x = s.x * W;
          const y = s.y * H;
          const r = 0.8 + 2.2 * Math.sqrt(Math.max(0, s.w || 0));
          const fill = s.result === "Goal" ? "#10b981" : "#0ea5e9";
          const strokeDot = prefersDark ? "#0b0f19" : "#ffffff";
          return <circle key={i} cx={x} cy={y} r={r} fill={fill} stroke={strokeDot} strokeWidth="0.6" opacity="0.95" />;
        })}
    </svg>
  );
}

/** SVG arc helper (angles in degrees) */
function describeArc(cx, cy, r, startAngleDeg, endAngleDeg) {
  const s = polarToCartesian(cx, cy, r, endAngleDeg);
  const e = polarToCartesian(cx, cy, r, startAngleDeg);
  const largeArc = endAngleDeg - startAngleDeg <= 180 ? "0" : "1";
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 0 ${e.x} ${e.y}`;
}
function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180.0;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

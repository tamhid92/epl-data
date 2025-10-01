import React, { useEffect, useMemo, useState } from "react";
import Navbar from "./components/Navbar";
import StandingsTable from "./components/StandingsTable";
import TeamModal from "./components/TeamModal";
import FixturesListModal from "./components/FixturesListModal";
import PlayersModal from "./components/PlayersModal";
import ResultsListModal from "./components/ResultsListModal";
import MatchCenter from "./components/MatchCenter";
import ContactModal from "./components/ContactModal";
import ResultsFixturesDeck from "./components/ResultsFixturesDeck";
import PredictionsPage from "./components/PredictionsPage";

/* Recharts */
import {
  ResponsiveContainer,
  ScatterChart, Scatter,
  XAxis, YAxis,
  CartesianGrid, Tooltip, Cell, LabelList,
  ReferenceLine,
  LineChart, Line,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Legend,
  RadialBarChart, RadialBar,
} from "recharts";

const OWNER_NAME = "Tamhid Chowdhury";
const CONTACT = {
  email: "tamhidchowdhury@gmail.com",
  github: "https://github.com/tamhid92",
  linkedin: "https://www.linkedin.com/in/tamhidchowdhury",
  website: "https://www.tchowdhury.org",
};
const OWNER_TITLE = "Cloud DevOps Engineer";
const OWNER_INTRO ="This football data analytics application is a personal project I built to showcase my skills in data engineering, cloud, and DevOps. It combines real match data with custom-built APIs, visualizations, and interactive dashboards to explore insights into the game. Everything is fully self-hosted, giving me the opportunity to design, deploy, and manage the entire stack—from database to front-end—just as I would in a production environment.";
const API_BASE = import.meta.env.VITE_BASE_URL;
const API_TOKEN = import.meta.env.VITE_API_TOKEN;

/* ─────────────────────── Team colour map ─────────────────────── */
const TEAM_COLORS = {
  Arsenal: "#EF0107",
  "Aston Villa": "#670E36",
  Bournemouth: "#DA291C",
  Brentford: "#D20000",
  Brighton: "#0057B8",
  Burnley: "#7A263A",
  Chelsea: "#034694",
  "Crystal Palace": "#1B458F",
  Everton: "#003399",
  Fulham: "#000000",
  Leeds: "#1D428A",
  Liverpool: "#C8102E",
  "Manchester City": "#6CABDD",
  "Manchester United": "#DA291C",
  "Newcastle United": "#241F20",
  "Nottingham Forest": "#DD0000",
  Sunderland: "#EB172B",
  Tottenham: "#132257",
  "West Ham": "#7A263A",
  "Wolverhampton Wanderers": "#FDB913",
};
const DEFAULT_PRIMARY = "#4F46E5";

/* ─────────────────────── Utilities ─────────────────────── */
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
const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);
const sum = (arr, k) => arr.reduce((s, r) => s + num(r[k]), 0);
const by = (arr, k, d = 0) => (arr?.find?.((r) => r?.situation === k)?.xG ?? d);
const round2 = (v) => (Number.isFinite(+v) ? Math.round(+v * 100) / 100 : 0);
const cx = (...a) => a.filter(Boolean).join(" ");
const logoUrl = (team) => `/logos/${encodeURIComponent(team)}.png`;

/* colours helpers */
function hexToRgb(hex) {
  const n = hex.replace("#", "");
  const bigint = parseInt(n.length === 3 ? n.split("").map((c) => c + c).join("") : n, 16);
  return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
}
function rgba(hex, a) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
function getTeamPrimary(team) {
  return TEAM_COLORS[team] || DEFAULT_PRIMARY;
}
function hexLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const srgb = [r, g, b].map(v => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}
function mixHex(a, b = "#ffffff", t = 0.5) {
  const A = hexToRgb(a), B = hexToRgb(b);
  const r = Math.round(A.r + (B.r - A.r) * t);
  const g = Math.round(A.g + (B.g - A.g) * t);
  const bch = Math.round(A.b + (B.b - A.b) * t);
  return `#${[r, g, bch].map(v => v.toString(16).padStart(2, "0")).join("")}`;
}
/** Ensures team color stays visible in dark mode. */
function getAccessibleVisColors(baseHex, isDark) {
  let stroke = baseHex;
  if (isDark && hexLuminance(stroke) < 0.24) {
    // Lighten dark colors against dark UI
    stroke = mixHex(stroke, "#ffffff", 0.45);
  }
  // Slightly translucent fill that still pops in both themes
  const fill = rgba(stroke, 0.28);
  const ring  = rgba(stroke, 0.35);
  return { stroke, fill, ring };
}
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = Number(xs[i]) || 0;
    const y = Number(ys[i]) || 0;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  const cov = sxy - (sx * sy) / n;
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  if (vx <= 0 || vy <= 0) return 0;
  return cov / Math.sqrt(vx * vy);
}
function linreg(xy) {
  const n = xy.length;
  if (n < 2) return { m: 0, b: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const { x, y } of xy) {
    const X = Number(x) || 0, Y = Number(y) || 0;
    sx += X; sy += Y; sxx += X * X; sxy += X * Y;
  }
  const m = (n * sxy - sx * sy) / Math.max(1e-9, n * sxx - sx * sx);
  const b = (sy - m * sx) / n;
  return { m, b };
}
function Spinner({ className = "" }) {
  return (
    <span
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-500 align-[-2px] ${className}`}
      aria-label="Loading"
    />
  );
}
/* Tiny hover helper + tag chips */
function HelpHint({ text, className = "" }) {
  return (
    <span className={cx("relative inline-flex items-center", className)}>
      <button
        type="button"
        className="group inline-flex items-center justify-center rounded-full p-0.5 text-zinc-500 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:text-zinc-400 dark:hover:text-zinc-200"
        aria-label="What is this?"
        title={text}
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 2-3 4" />
          <line x1="12" y1="17" x2="12" y2="17" />
        </svg>
        <span className="pointer-events-none absolute left-1/2 top-[125%] z-30 hidden w-64 -translate-x-1/2 rounded-md border border-zinc-200 bg-white px-2.5 py-2 text-[11px] leading-snug text-zinc-700 shadow-lg group-hover:block dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
          {text}
        </span>
      </button>
    </span>
  );
}

/* Intent-coloured tag chip using good / bad / warn */
function StatusTag({ children, intent = "default" }) {
  const color =
    intent === "good"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : intent === "bad"
      ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
      : intent === "warn"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
      : "bg-zinc-500/10 text-zinc-700 dark:text-zinc-300";
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold shadow-sm", color)}>
      {children}
    </span>
  );
}

/* Presentational bits */
function Panel({ title, help, children }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <span>{title}</span>
        {help ? <HelpHint text={help} /> : null}
      </div>
      {children}
    </div>
  );
}
function TeamPill({ label, logo, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition",
        active
          ? "border-indigo-500 bg-indigo-50/60 text-indigo-800 shadow-sm ring-1 ring-indigo-400/40 dark:border-indigo-400 dark:bg-indigo-900/20 dark:text-indigo-100"
          : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
      )}
      title={label}
      style={{ whiteSpace: "normal", lineHeight: 1.1 }}
    >
      <img
        src={logo}
        alt=""
        className="h-5 w-5 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
        onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
      />
      <span className="font-medium">{label}</span>
    </button>
  );
}
function SiteFooter({ ownerName }) {
  const year = new Date().getFullYear();
  return (
    <footer className="mx-auto mt-10 w-full max-w-6xl px-4 md:px-6">
      <div className="border-t border-zinc-200 py-6 text-center text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        <div className="mb-1">© {year} {ownerName}</div>
        <div className="space-y-0.5 leading-relaxed">
          <div>This application is not affiliated with the English Premier League in any way.</div>
          <div>
            Data scraped from{" "}
            <a href="https://understat.com" target="_blank" rel="noreferrer" className="underline decoration-dotted hover:decoration-solid">
              Understat
            </a> and
            {" "}
            <a href="https://fbref.com" target="_blank" rel="noreferrer" className="underline decoration-dotted hover:decoration-solid">
              FbRef
            </a>.
          </div>
          <div>For educational and research purposes only.</div>
        </div>
      </div>
    </footer>
  );
}

/* Scatter tooltip with team name */
function ScatterTip({ active, payload, xLabel = "X", yLabel = "Y", fmtX = (v) => v, fmtY = (v) => v }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload || {};
  const team = p.team || p.Team || "";
  const px = payload[0]?.value;
  const py = payload[1]?.value;
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs shadow-md dark:border-zinc-800 dark:bg-zinc-950">
      <div className="font-semibold">{team}</div>
      <div className="tabular-nums">{xLabel}: {fmtX(px)}</div>
      <div className="tabular-nums">{yLabel}: {fmtY(py)}</div>
    </div>
  );
}

/* ─────────────────────── League Analysis ─────────────────────── */
const HELP = {
  insights: "Team style & effectiveness inferred from pressing (PPDA), shot zone mix, creation sources, timing, and finishing vs xG.",
  npx: "Non-penalty xG (x-axis) vs Non-penalty xGA (y-axis). Bottom-right is best: create a lot, concede little.",
  press: "Pressing profile: PPDA (lower = more aggressive pressing) vs Opponent PPDA.",
  g_xg_scatter: "Goals per match (y) vs xG per match (x). Above the diagonal = finishing above xG.",
  zones: "Three mini-scatters: For% (x) vs Against% (y) share of xG by location.",
  ppda_dc: "PPDA: passes per defensive action (lower = more pressing). DC: dangerous chances created.",
  fin_def: "Finishing (Goals ÷ xG) vs Defensive Overperformance (xGA ÷ GA). Top-right suggests clinical attack and resilient defense.",
  bumpy: "Weekly league table trajectory. Y-axis is position (1=top). Click a dot/line or a logo to highlight a team.",
};

function KPI({ label, value, sub, avg, color = DEFAULT_PRIMARY }) {
  const ring = rgba(color, 0.35);
  const bg = `linear-gradient(135deg, ${rgba(color, 0.12)}, transparent 65%)`;
  return (
    <div
      className="rounded-xl border px-3 py-2 text-sm shadow-sm backdrop-blur"
      style={{ borderColor: ring, background: bg }}
    >
      <div className="text-[11px] font-medium">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {avg !== undefined ? (
        <div className="mt-0.5 text-[12px] text-zinc-600 dark:text-zinc-400">
          League avg: <span className="tabular-nums">{avg}</span>
        </div>
      ) : null}
      {sub ? (
        <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{sub}</div>
      ) : null}
    </div>
  );
}
function KpiGauge({
  label,
  value,
  avg,
  min = 0,
  max = 1,
  better = "higher",
  fmt = (v) => v,
  color = DEFAULT_PRIMARY,
  size = "sm",
}) {
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const span = Math.max(1e-9, max - min);
  const toPct = (x) => clamp(((Number(x) - min) / span) * 100, 0, 100);

  const vPct = toPct(value);
  const aPct = toPct(avg);

  const dense = size === "sm";
  const cardPad  = dense ? "p-2"  : "p-3";
  const chartH   = dense ? "h-28" : "h-40";
  const labelCls = dense ? "text-[10px]" : "text-[11px]";
  const valueCls = dense ? "text-base"   : "text-lg";
  const avgCls   = dense ? "text-[10px]" : "text-[11px]";
  const chipCls  = dense ? "text-[9px] px-1.5 py-0.5" : "text-[10px] px-2 py-0.5";

  // SUPER-THIN rings (≈1–1.6% thickness)
  const AVG_IN  = dense ? "99.1%" : "99.0%";
  const AVG_OUT = dense ? "99.6%" : "99.5%";
  const VAL_IN  = dense ? "86.2%" : "86.0%";
  const VAL_OUT = dense ? "86.7%" : "86.5%";

  const startAngle = 210, endAngle = -30;

  const data = [{ track: 100, avg: aPct, val: vPct }];
  const centerYOffset = dense ? "10%" : "8%";

  const deltaRaw = (Number(avg) > 0)
    ? (better === "higher" ? (value - avg) / avg : (avg - value) / avg)
    : 0;
  const deltaPct = clamp(deltaRaw * 100, -999, 999);

  return (
    <div className={`rounded-xl border border-zinc-200 bg-white ${cardPad} shadow-sm dark:border-zinc-800 dark:bg-zinc-950`}>
      <div className={`mb-0.5 font-medium text-zinc-600 dark:text-zinc-400 ${labelCls}`}>{label}</div>
      <div className={`relative ${chartH}`}>
        <ResponsiveContainer>
          <RadialBarChart data={data} startAngle={startAngle} endAngle={endAngle}>
            {/* hairline track (very light) */}
            <RadialBar
              dataKey="track"
              clockWise
              fill="rgba(148,163,184,0.15)"     // slate-400/15
              innerRadius={AVG_IN}
              outerRadius={AVG_OUT}
              cornerRadius={0}
              isAnimationActive={false}
            />
            {/* league avg line (outer) */}
            <RadialBar
              dataKey="avg"
              clockWise
              fill="rgba(100,116,139,0.55)"     // slate-500/55
              innerRadius={AVG_IN}
              outerRadius={AVG_OUT}
              cornerRadius={0}
            />
            {/* team value line (inner) */}
            <RadialBar
              dataKey="val"
              clockWise
              fill={color}
              innerRadius={VAL_IN}
              outerRadius={VAL_OUT}
              cornerRadius={0}
            />
          </RadialBarChart>
        </ResponsiveContainer>

        {/* center labels */}
        <div className="pointer-events-none absolute inset-0 grid place-items-center"
            style={{ transform: `translateY(${centerYOffset})` }}>
          <div className="text-center">
            <div className={`${valueCls} font-semibold tabular-nums`}>{fmt(value)}</div>
            <div className={`${avgCls} text-zinc-500`}>Avg {fmt(avg)}</div>
            <div
              className={[
                `mx-auto mt-0.5 w-fit rounded-full ${chipCls} font-semibold`,
                deltaPct > 2 ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" :
                deltaPct < -2 ? "bg-rose-500/15 text-rose-700 dark:text-rose-300" :
                                "bg-zinc-500/10 text-zinc-700 dark:text-zinc-300"
              ].join(" ")}
            >
              {deltaPct >= 0 ? "▲" : "▼"} {Math.abs(deltaPct).toFixed(0)}%
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


function LeagueAnalysisSection({ apiBase, standings, teams, onOpenTeam, onOpenPlayer, isDark = false }) {
  const [createdMap, setCreatedMap] = useState({});
  const [zonesMap, setZonesMap] = useState({});
  const [zonesConMap, setZonesConMap] = useState({});
  const [timingMap, setTimingMap] = useState({});
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [errDetails, setErrDetails] = useState(null);
  const [fbrefMap, setFbrefMap] = useState({});
  const [fbrefVsMap, setFbrefVsMap] = useState({});
  // FBref league maps
  const [fbrefAll, setFbrefAll] = useState(null);
  const [fbrefVs,  setFbrefVs]  = useState(null);
  const [fbrefLoading, setFbrefLoading] = useState(false);
  const [fbrefErr, setFbrefErr] = useState(null);

  // Leaders
  const [leaders, setLeaders] = useState({ goals: [], assists: [], xg: [], xa: [] });
  const [loadingLeaders, setLoadingLeaders] = useState(false);
  const [errLeaders, setErrLeaders] = useState(null);


  const [selectedTeam, setSelectedTeam] = useState(""); // "" = All
  const themeColor = useMemo(() => getTeamPrimary(selectedTeam), [selectedTeam]);
  const vis = useMemo(() => getAccessibleVisColors(themeColor, isDark), [themeColor, isDark]);

  // Build fbrefMap from fbrefAll (league blob) — no per-team network calls
  useEffect(() => {
    if (!fbrefAll) { setFbrefMap({}); return; }

    const out = {};
    for (const [t, obj] of Object.entries(fbrefAll)) {
      const std  = obj?.standard || {};
      const gsc  = obj?.goal_and_shot_creation || {};
      const pass = obj?.passing || {};
      const ptyp = obj?.pass_types || {};
      const poss = obj?.possession || {};
      const def  = obj?.defensive || {};
      const gk   = obj?.goalkeeping || {};

      const n90 = Number(std.playing_time_90s || gk.playing_time_90s || 0) || 0;
      const totalPass =
        Number(pass.total_att || 0) ||
        (Number(pass.short_att || 0) + Number(pass.medium_att || 0) + Number(pass.long_att || 0));

      const divLocal = (n, d) => (d > 0 ? Number(n) / d : 0);
      const pctLocal = (n, d) => (d > 0 ? (Number(n) / d) * 100 : 0);

      out[t] = {
        n90,
        sca90: Number(gsc.sca_sca90 || 0),
        gca90: Number(gsc.gca_gca90 || 0),
        shortShare: pctLocal(pass.short_att || 0, totalPass),
        longShare:  pctLocal(pass.long_att  || 0, totalPass),
        crossPer100: totalPass ? (Number(ptyp.pass_types_crs || 0) / totalPass) * 100 : 0,
        deadShare:   pctLocal(ptyp.pass_types_dead || 0, totalPass),

        takeOnSuccPct: Number(poss.take_ons_succpct || 0),
        takeOnsPer90:   divLocal(poss.take_ons_att || 0, n90),

        progPPer90:     divLocal(pass.prgp || 0, n90),
        progCPer90:     divLocal(poss.carries_prgc || 0, n90),
        boxTouchesPer90: divLocal(poss.touches_att_pen || 0, n90),
        prgrPer90:       divLocal(poss.receiving_prgr || 0, n90),

        tklIntPer90:     divLocal(def.tklplusint || 0, n90),
        intPer90:        divLocal(def.int || 0, n90),
        blocksPer90:     divLocal(def.blocks_blocks || 0, n90),
        tklWinPct:       Number(def.challenges_tklpct || 0),

        savePct:         Number(gk.performance_savepct || 0),
      };
    }
    setFbrefMap(out);
  }, [fbrefAll]);

  // Build fbrefVsMap from fbrefVs (league blob) — no per-team network calls
  useEffect(() => {
    if (!fbrefVs) { setFbrefVsMap({}); return; }

    const out = {};
    for (const [t, obj] of Object.entries(fbrefVs)) {
      const vstd  = obj?.standard || {};
      const vgsc  = obj?.goal_and_shot_creation || {};
      const vpass = obj?.passing || {};
      const vptype= obj?.pass_types || {};
      const vposs = obj?.possession || {};
      const vdef  = obj?.defensive || {};
      const vgk   = obj?.goalkeeping || {};

      const n90v = Number(vstd.playing_time_90s || vgk.playing_time_90s || 0) || 0;
      const totalPassOpp =
        Number(vpass.total_att || 0) ||
        (Number(vpass.short_att || 0) + Number(vpass.medium_att || 0) + Number(vpass.long_att || 0));

      const divLocal = (n, d) => (d > 0 ? Number(n) / d : 0);

      out[t] = {
        n90: n90v,

        // Opponents’ creation vs this team
        oppSCA90: Number(vgsc.sca_sca90 || (vgsc.sca_sca && n90v ? vgsc.sca_sca / n90v : 0) || 0),
        oppGCA90: Number(vgsc.gca_gca90 || (vgsc.gca_gca && n90v ? vgsc.gca_gca / n90v : 0) || 0),

        // Conceding profile
        ga90: Number(vgk.performance_ga90 || (vgk.performance_ga && n90v ? vgk.performance_ga / n90v : 0) || 0),
        savePctOpp: Number(vgk.performance_savepct || 0),

        // Progression allowed
        oppProgPPer90: divLocal(vpass.prgp || 0, n90v),
        oppProgCPer90: divLocal(vposs.carries_prgc || 0, n90v),

        // Dangerous zone access
        oppBoxTouchesPer90: divLocal(vposs.touches_att_pen || 0, n90v),

        // Crossing volume allowed
        oppCrossPer100: totalPassOpp ? (Number(vptype.pass_types_crs || 0) / totalPassOpp) * 100 : 0,

        // Duels & defensive activity
        duelWinPct: Number(vdef.challenges_tklpct || 0),
        tklIntPer90: divLocal(vdef.tklplusint || 0, n90v),
        blocksPer90: divLocal(vdef.blocks_blocks || 0, n90v),
      };
    }
    setFbrefVsMap(out);
  }, [fbrefVs]);


  useEffect(() => {
    if (!apiBase) return;
    let cancelled = false;
    (async () => {
      try {
        setFbrefLoading(true); setFbrefErr(null);
        const [all, vs] = await Promise.all([
          fetchJson(`${apiBase}/fbref/all_teams`),
          fetchJson(`${apiBase}/fbref/vs_all_teams`),
        ]);
        if (cancelled) return;
        const unwrap = (arr, key) => (Array.isArray(arr) && arr[0] && arr[0][key]) || {};
        setFbrefAll(unwrap(all, "get_fbref_team_json_all"));
        setFbrefVs( unwrap(vs,  "get_fbref_vs_team_json_all"));
      } catch (e) {
        if (!cancelled) setFbrefErr(String(e));
      } finally {
        if (!cancelled) setFbrefLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase]);


  // Load per-team details (Understat only: created/zones/timing)
  useEffect(() => {
    const ts = (standings?.length ? standings.map((r) => r.Team) : teams) || [];
    if (!apiBase || !ts.length) return;

    let cancelled = false;
    (async () => {
      try {
        setLoadingDetails(true);
        setErrDetails(null);

        const MAX_CONC = 5;
        const queue = [...ts];
        const _c = {}, _z = {}, _za = {}, _t = {};

        async function loadTeam(t) {
          try {
            const [created, zones, zonesCon, timing] = await Promise.all([
              fetchJson(`${apiBase}/chances_created/${encodeURIComponent(t)}`),
              fetchJson(`${apiBase}/shot_zone/${encodeURIComponent(t)}`),
              fetchJson(`${apiBase}/shot_zone_conceded/${encodeURIComponent(t)}`),
              fetchJson(`${apiBase}/timing/${encodeURIComponent(t)}`),
            ]);
            _c[t] = Array.isArray(created) ? created : [];
            _z[t] = Array.isArray(zones) ? zones : [];
            _za[t] = Array.isArray(zonesCon) ? zonesCon : [];
            _t[t] = Array.isArray(timing) ? timing : [];
          } catch {
            /* ignore single-team failure */
          }
        }

        const workers = Array.from(
          { length: Math.min(MAX_CONC, queue.length) },
          async () => { while (queue.length && !cancelled) await loadTeam(queue.shift()); }
        );

        await Promise.all(workers);
        if (cancelled) return;

        setCreatedMap(_c);
        setZonesMap(_z);
        setZonesConMap(_za);
        setTimingMap(_t);
      } catch (e) {
        if (!cancelled) setErrDetails(String(e));
      } finally {
        if (!cancelled) setLoadingDetails(false);
      }
    })();

    return () => { cancelled = true; };
  }, [apiBase, standings, teams]);

  // Load league leaders (top 5)
  useEffect(() => {
    if (!apiBase) return;
    let ignore = false;

    function mapRow(p) {
      return {
        id: String(p.id),
        player: p.player_name,
        team: p.team_title || "",
        goals: num(p.goals),
        assists: num(p.assists),
        xG: num(p.xG) || num(p.npxG),
        xA: num(p.xA),
        mins: num(p.time),
      };
    }

    (async () => {
      try {
        setLoadingLeaders(true);
        setErrLeaders(null);
        const [g, a, xg, xa] = await Promise.all([
          fetchJson(`${apiBase}/leaders/goals`),
          fetchJson(`${apiBase}/leaders/assists`),
          fetchJson(`${apiBase}/leaders/xg`),
          fetchJson(`${apiBase}/leaders/xa`),
        ]);
        if (ignore) return;
        setLeaders({
          goals: (Array.isArray(g) ? g : []).map(mapRow),
          assists: (Array.isArray(a) ? a : []).map(mapRow),
          xg: (Array.isArray(xg) ? xg : []).map(mapRow),
          xa: (Array.isArray(xa) ? xa : []).map(mapRow),
        });
      } catch (e) {
        if (!ignore) setErrLeaders(String(e));
      } finally {
        if (!ignore) setLoadingLeaders(false);
      }
    })();

    return () => { ignore = true; };
  }, [apiBase]);

  const teamRows = useMemo(() => {
    const s = Array.isArray(standings) ? standings : [];
    return s.map((r) => {
      const t = r.Team;
      const created = createdMap[t] || [];
      const zones = zonesMap[t] || [];
      const zc = zonesConMap[t] || [];
      const timing = timingMap[t] || [];

      const openFor = by(created, "OpenPlay", 0);
      const corFor  = by(created, "FromCorner", 0);
      const penFor  = by(created, "Penalty", 0);

      const zxg  = sum(zones, "xG") || 0.0001;
      const zcxg = sum(zc, "xG") || 0.0001;
      const sixFor = zones.find((z) => z.zone === "shotSixYardBox")?.xG ?? 0;
      const penForX = zones.find((z) => z.zone === "shotPenaltyArea")?.xG ?? 0;
      const obFor = zones.find((z) => z.zone === "shotOboxTotal")?.xG ?? 0;
      const sixAg = zc.find((z) => z.zone === "shotSixYardBox")?.xG ?? 0;
      const penAgX = zc.find((z) => z.zone === "shotPenaltyArea")?.xG ?? 0;
      const obAg = zc.find((z) => z.zone === "shotOboxTotal")?.xG ?? 0;

      const early = timing.filter((b) => ["1-15", "16-30"].includes(b.period));
      const late  = timing.filter((b) => ["76+"].includes(b.period));

      return {
        Team: t,
        G: num(r.G), GA: num(r.GA), GD: num(r.G) - num(r.GA), M: num(r.M),
        PTS: num(r.PTS), xG: num(r.xG), xGA: num(r.xGA), xPTS: num(r.xPTS),
        NPxG: num(r.NPxG), NPxGA: num(r.NPxGA), NPxGD: num(r.NPxGD),
        PPDA: num(r.PPDA), OPPDA: num(r.OPPDA), DC: num(r.DC),

        xG_open_for: openFor,
        xG_corner_for: corFor,
        xG_pen_for: penFor,
        xG_created_total: openFor + corFor + penFor,

        six_for_pct: pct(sixFor, zxg), pen_for_pct: pct(penForX, zxg), obox_for_pct: pct(obFor, zxg),
        six_ag_pct: pct(sixAg, zcxg),  pen_ag_pct: pct(penAgX, zcxg),  obox_ag_pct: pct(obAg, zcxg),

        xG_early: sum(early, "xG"), xG_late: sum(late, "xG"),
      };
    });
  }, [standings, createdMap, zonesMap, zonesConMap, timingMap]);

  /* Scatters data */
  const scatNPx = useMemo(
    () => teamRows.map((r) => ({
      team: r.Team,
      npxg: r.NPxG,
      npxga: r.NPxGA,
      r: selectedTeam ? (r.Team === selectedTeam ? 6 : 3) : 4,
      dim: selectedTeam ? (r.Team === selectedTeam ? 1 : 0.35) : 0.9,
      hl: selectedTeam && r.Team === selectedTeam
    })),
    [teamRows, selectedTeam]
  );
  const scatPress = useMemo(
    () => teamRows.map((r) => ({
      team: r.Team,
      ppda: r.PPDA,
      oppda: r.OPPDA,
      r: selectedTeam ? (r.Team === selectedTeam ? 6 : 3) : 4,
      dim: selectedTeam ? (r.Team === selectedTeam ? 1 : 0.35) : 0.9,
      hl: selectedTeam && r.Team === selectedTeam
    })),
    [teamRows, selectedTeam]
  );
  const gxg = useMemo(() => {
    const base = teamRows.map((r) => ({
      team: r.Team,
      xgpm: r.M ? r.xG / r.M : 0,
      gpm:  r.M ? r.G  / r.M : 0,
      r: selectedTeam ? (r.Team === selectedTeam ? 6 : 3) : 4,
      dim: selectedTeam ? (r.Team === selectedTeam ? 1 : 0.35) : 0.9,
      hl: selectedTeam && r.Team === selectedTeam
    }));
    const max = Math.max(0.8, ...base.map(d => Math.max(d.xgpm, d.gpm))) * 1.15;
    return { data: base, max };
  }, [teamRows, selectedTeam]);
  const zoneTriptych = useMemo(() => {
    return teamRows.map((r) => ({
      team: r.Team,
      sixF: r.six_for_pct, sixA: r.six_ag_pct,
      penF: r.pen_for_pct, penA: r.pen_ag_pct,
      obF:  r.obox_for_pct, obA:  r.obox_ag_pct,
      r: selectedTeam ? (r.Team === selectedTeam ? 6 : 3) : 4,
      dim: selectedTeam ? (r.Team === selectedTeam ? 1 : 0.35) : 0.9,
      hl: selectedTeam && r.Team === selectedTeam
    }));
  }, [teamRows, selectedTeam]);

  /* EXTRA VIS */
  const finDef = useMemo(() => {
    return teamRows.map((r) => {
      const finishing = r.xG > 0 ? r.G / r.xG : 0;
      const defOver   = r.GA > 0 ? r.xGA / r.GA : 0;
      return {
        team: r.Team,
        finishing,
        defOver,
        r: selectedTeam ? (r.Team === selectedTeam ? 6 : 3) : 4,
        dim: selectedTeam ? (r.Team === selectedTeam ? 1 : 0.35) : 0.9,
        hl: selectedTeam && r.Team === selectedTeam
      };
    });
  }, [teamRows, selectedTeam]);

  /* Insights + themed header — TAGS */
  const selectedRow = useMemo(
    () => (selectedTeam ? teamRows.find((x) => x.Team === selectedTeam) : null),
    [selectedTeam, teamRows]
  );

  const fbrefAvg = useMemo(() => {
    const vals = Object.values(fbrefMap);
    const n = vals.length || 0;
    if (!n) return null;
    const sum = (k) => vals.reduce((a,v)=> a + (Number(v?.[k]) || 0), 0) / n;
    return {
      sca90: sum('sca90'),
      gca90: sum('gca90'),
      crossPer100: sum('crossPer100'),
      takeOnSuccPct: sum('takeOnSuccPct'),
      progTotalPer90: sum('progPPer90') + sum('progCPer90'),
      boxTouchesPer90: sum('boxTouchesPer90'),
    };
  }, [fbrefMap]);

  const fbrefVsAvg = useMemo(() => {
    const vals = Object.values(fbrefVsMap);
    const n = vals.length || 0;
    if (!n) return null;
    const avg = (k) => vals.reduce((a, v) => a + (Number(v?.[k]) || 0), 0) / n;
    return {
      ga90: avg("ga90"),
      oppSCA90: avg("oppSCA90"),
      oppProgTotalPer90: avg("oppProgPPer90") + avg("oppProgCPer90"),
      oppBoxTouchesPer90: avg("oppBoxTouchesPer90"),
    };
  }, [fbrefVsMap]);

  const selectedFb = useMemo(() => {
    if (!selectedTeam) return null;
    return fbrefMap[selectedTeam] || null;
  }, [selectedTeam, fbrefMap]);

  const selectedFbVs = useMemo(() => {
    if (!selectedTeam) return null;
    return fbrefVsMap[selectedTeam] || null;
  }, [selectedTeam, fbrefVsMap]);


  const insightTags = useMemo(() => {
    if (!selectedRow) return null;
    const r = selectedRow;
    const tags = [];

    if (r.PPDA <= 9) tags.push(<StatusTag key="press-hi" intent="good">High press</StatusTag>);
    else if (r.PPDA >= 12) tags.push(<StatusTag key="press-low" intent="warn">Mid/low block</StatusTag>);

    if (r.OPPDA <= 10) tags.push(<StatusTag key="opp-pressed" intent="good">Forces rushed buildup</StatusTag>);

    const boxShare = r.six_for_pct + r.pen_for_pct;
    if (boxShare >= 70) tags.push(<StatusTag key="boxy" intent="good">Box-centric shots</StatusTag>);
    if (r.obox_for_pct >= 35) tags.push(<StatusTag key="long" intent="bad">Long-shot heavy</StatusTag>);

    const createdTotal = r.xG_created_total || 0.0001;
    if (r.xG_corner_for / createdTotal > 0.28) tags.push(<StatusTag key="set" intent="warn">Set-piece reliant</StatusTag>);

    if (r.xG_late >= r.xG_early) tags.push(<StatusTag key="late" intent="good">Strong closers</StatusTag>);
    else tags.push(<StatusTag key="early" intent="good">Fast starters</StatusTag>);

    const finishRatio = r.xG > 0 ? r.G / r.xG : 1;
    if (finishRatio >= 1.1 && r.xG > 2) tags.push(<StatusTag key="clinical" intent="good">Clinical finishing</StatusTag>);
    if (finishRatio <= 0.9 && r.xG > 2) tags.push(<StatusTag key="cold" intent="bad">Underperforming chances</StatusTag>);

    if (r.NPxGD / Math.max(1, r.M) >= 0.5) tags.push(<StatusTag key="dom" intent="good">Territorial dominance</StatusTag>);

    // --- NEW: dial up negatives using existing Understat-derived fields ---
    if (boxShare < 45) {
      tags.push(<StatusTag key="perimeter" intent="warn">Perimeter shooters</StatusTag>);
    }

    if (r.PPDA >= 14) {
      tags.push(<StatusTag key="passive-press" intent="bad">Passive out of possession</StatusTag>);
    }

    if (r.OPPDA >= 14) {
      tags.push(<StatusTag key="opp-comfy" intent="bad">Opponents build comfortably</StatusTag>);
    }
    if (r.xG_early > 0 && r.xG_late <= 0.6 * r.xG_early) {
      tags.push(<StatusTag key="fade-late" intent="warn">Fades late in games</StatusTag>);
    }

    const fb = (typeof selectedFb !== "undefined" && selectedFb) ? selectedFb : null;

    if (fb) {
      if (fb.crossPer100 >= 5) {
        tags.push(<StatusTag key="cross-hope" intent="warn">Cross-and-hope</StatusTag>);
      }
      if ((fb.progPPer90 + fb.progCPer90) < 30) {
        tags.push(<StatusTag key="no-prog" intent="bad">Struggles to progress</StatusTag>);
      }
      if (fb.boxTouchesPer90 < 15) {
        tags.push(<StatusTag key="rare-box" intent="bad">Rarely in the box</StatusTag>);
      }
      if (fb.takeOnSuccPct < 40 && fb.takeOnsPer90 >= 8) {
        tags.push(<StatusTag key="ineff-dribble" intent="bad">Inefficient dribbling</StatusTag>);
      }
      if (fb.tklIntPer90 < 12) {
        tags.push(<StatusTag key="passive-def" intent="bad">Passive defending</StatusTag>);
      }
      if (fb.savePct && fb.savePct < 64) {
        tags.push(<StatusTag key="gk-issue" intent="warn">Shaky GK form</StatusTag>);
      }
    }

    const v = (typeof selectedFbVs !== "undefined" && selectedFbVs) ? selectedFbVs : null;

    if (v) {
      const oppProgTotal = (v.oppProgPPer90 || 0) + (v.oppProgCPer90 || 0);

      // Conceding profile
      if (v.ga90 >= 1.6) {
        tags.push(<StatusTag key="vs-ga" intent="bad">Leaky: GA/90 is high</StatusTag>);
      }
      if (v.savePctOpp > 0 && v.savePctOpp < 55) {
        tags.push(<StatusTag key="vs-gk-bad" intent="bad">Shot-stopping issues</StatusTag>);
      } else if (v.savePctOpp > 0 && v.savePctOpp < 62) {
        tags.push(<StatusTag key="vs-gk-warn" intent="warn">Below-par save %</StatusTag>);
      }

      // Chance creation allowed
      if (v.oppSCA90 >= 24) {
        tags.push(<StatusTag key="vs-sca" intent="warn">Allows high shot creation</StatusTag>);
      }
      if (v.oppGCA90 >= 1.5) {
        tags.push(<StatusTag key="vs-gca" intent="bad">Concedes big chances</StatusTag>);
      }

      // Field progression allowed
      if (oppProgTotal >= 45) {
        tags.push(<StatusTag key="vs-prog" intent="bad">Opponents progress too easily</StatusTag>);
      }

      // Dangerous zone access
      if (v.oppBoxTouchesPer90 >= 20) {
        tags.push(<StatusTag key="vs-box" intent="bad">Opponents reach box often</StatusTag>);
      }

      // Crossing volume allowed
      if (v.oppCrossPer100 >= 5) {
        tags.push(<StatusTag key="vs-cross" intent="warn">Crosses allowed frequently</StatusTag>);
      }

      // Defensive intensity/duels
      if (v.duelWinPct > 0 && v.duelWinPct < 50) {
        tags.push(<StatusTag key="vs-duels" intent="bad">Low 1v1 success</StatusTag>);
      }
      if (v.tklIntPer90 > 0 && v.tklIntPer90 < 14) {
        tags.push(<StatusTag key="vs-activity" intent="warn">Low defensive activity</StatusTag>);
      }
    }

    return tags;
  }, [selectedRow, selectedFb, selectedFbVs]);

  const selectedKpis = useMemo(() => {
    if (!selectedRow) return null;
    const r = selectedRow;
    const npxgdPM = r.M ? r.NPxGD / r.M : 0;
    const finishRatio = r.xG > 0 ? r.G / r.xG : 1;
    const boxShare = r.six_for_pct + r.pen_for_pct;
    return { npxgdPM, finishRatio, boxShare, ppda: r.PPDA };
  }, [selectedRow]);

  const leagueAvg = useMemo(() => {
    const n = teamRows.length || 1;
    const sums = teamRows.reduce(
      (a, r) => {
        a.npxgdPM += r.M ? r.NPxGD / r.M : 0;
        a.finishRatio += r.xG > 0 ? r.G / r.xG : 1;
        a.boxShare += (r.six_for_pct + r.pen_for_pct);
        a.ppda += r.PPDA;
        return a;
      },
      { npxgdPM: 0, finishRatio: 0, boxShare: 0, ppda: 0 }
    );
    return {
      npxgdPM: sums.npxgdPM / n,
      finishRatio: sums.finishRatio / n,
      boxShare: sums.boxShare / n,
      ppda: sums.ppda / n,
    };
  }, [teamRows]);

  // -------------------------------------------------------------------------------------

  const kpiDomains = useMemo(() => {
    const clampList = (arr) => arr.filter((x) => Number.isFinite(Number(x)));
    const rows = teamRows || [];

    const finishing = clampList(rows.map(r => (r.xG > 0 ? r.G / r.xG : 1)));
    const boxShare  = clampList(rows.map(r => (r.six_for_pct + r.pen_for_pct)));
    const ppdaList  = clampList(rows.map(r => r.PPDA));

    const fbVals = Object.values(fbrefMap || {});
    const sca90  = clampList(fbVals.map(v => v.sca90));
    const gca90  = clampList(fbVals.map(v => v.gca90));
    const prog   = clampList(fbVals.map(v => (Number(v.progPPer90) + Number(v.progCPer90))));
    const boxT90 = clampList(fbVals.map(v => v.boxTouchesPer90));
    const drbSucc= clampList(fbVals.map(v => v.takeOnSuccPct));

    const span = (arr, dflt) => {
      if (!arr.length) return dflt;
      return [Math.min(...arr), Math.max(...arr)];
    };

    return {
      finishing: span(finishing, [0.6, 1.6]),
      boxShare:  span(boxShare,  [20, 80]),
      ppda:      span(ppdaList,  [6, 18]),
      sca90:     span(sca90,     [10, 35]),
      gca90:     span(gca90,     [0.5, 2.5]),
      prog:      span(prog,      [20, 60]),
      boxT90:    span(boxT90,    [8, 30]),
      drbSucc:   span(drbSucc,   [30, 70]),
    };
  }, [teamRows, fbrefMap]);

  const fmtNum = (x) => (Number(x) || 0).toFixed(2);
  const fmtPct = (x) => `${Math.round(Number(x) || 0)}%`;

  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  // Build a normalized 0–1 “style” vector for every team, preferring FBref, with fallbacks to your existing rows
  const styleLeague = useMemo(() => {
    const metrics = ["Pressing", "Possession", "Progression", "Creation", "Finishing"];
    const rows = [];

    const leagueTeams = (standings?.map(r => r.Team) || teams || []).filter(Boolean);

    for (const t of leagueTeams) {
      const T = fbrefAll?.[t] || {};
      const V = fbrefVs?.[t]  || {};
      const r = teamRows.find(x => x.Team === t) || {};

      // ── Pressing: FBref defensive challenges per 90 (higher = more aggressive). Fallback: inverse PPDA.
      const press90 = Number(T?.defensive?.challenges_att) / Math.max(1, Number(T?.standard?.playing_time_90s));
      const pressing = Number.isFinite(press90) && press90 > 0 ? press90 : (r.PPDA > 0 ? (1 / r.PPDA) : 0);

      // ── Possession: FBref % if present, else rough proxy from your model (use DC & NPxGD as weak fallback)
      const possession = Number(T?.possession?.poss) || Math.max(0, (r.DC || 0) + Math.max(0, r.NPxGD || 0));

      // ── Progression: progressive passes + progressive carries
      const progPass = Number(T?.passing?.prgp) || 0;
      const progCarr = Number(T?.possession?.carries_prgc) || 0;
      const progression = progPass + progCarr || (r.NPxG || 0); // fallback

      // ── Creation: GCA per 90 (goal-creating actions)
      const gca90 = Number(T?.goal_and_shot_creation?.gca_gca90);
      const creation = Number.isFinite(gca90) ? gca90 : ((r.xG_created_total || 0) / Math.max(1, r.M || 1));

      // ── Finishing: Goals ÷ xG
      const gls = Number(T?.standard?.performance_gls);
      const xg  = Number(T?.shooting?.expected_xg);
      const finishing = xg > 0 ? gls / xg : (r.xG > 0 ? r.G / r.xG : 1);

      rows.push({ team: t, Pressing: pressing, Possession: possession, Progression: progression, Creation: creation, Finishing: finishing });
    }

    // Normalize each metric to 0–1 across the league
    const mins = {}, maxs = {};
    metrics.forEach(k => { mins[k] = Infinity; maxs[k] = -Infinity; });
    rows.forEach(r => metrics.forEach(k => { mins[k] = Math.min(mins[k], r[k]); maxs[k] = Math.max(maxs[k], r[k]); }));

    const norm = rows.map(r => {
      const o = { team: r.team };
      metrics.forEach(k => { const span = (maxs[k] - mins[k]) || 1; o[k] = clamp01((r[k] - mins[k]) / span); });
      return o;
    });

    return { metrics, data: norm };
  }, [fbrefAll, fbrefVs, teamRows, standings, teams]);

  const styleRadarData = useMemo(() => {
    if (!selectedTeam || !styleLeague?.data?.length) return [];
    const row = styleLeague.data.find(d => d.team === selectedTeam);
    if (!row) return [];
    return styleLeague.metrics.map(m => ({ metric: m, value: row[m] }));
  }, [styleLeague, selectedTeam]);

  // ────────────────── Defensive Radar (vs_team) ──────────────────
  // tiny safe getter
  const pickN = (obj, path, d = 0) => {
    try {
      const v = path.split(".").reduce((o, k) => o?.[k], obj);
      const n = Number(v);
      return Number.isFinite(n) ? n : d;
    } catch { return d; }
  };

  // Build raw per-team "against" volumes from fbrefVs (opposition stats vs team)
  const defenseRaw = useMemo(() => {
    if (!fbrefVs) return [];
    const rows = [];
    for (const team of Object.keys(fbrefVs)) {
      const t = fbrefVs[team] || {};
      const n90s =
        pickN(t.standard, "playing_time_90s", 0) ||
        pickN(t.goalkeeping, "playing_time_90s", 0) || 0;

      const safePer90 = (v, n) => (n > 0 ? v / n : 0);

      // xGA/90 (use expected_xg field from vs shooting)
      const xga90 = safePer90(pickN(t.shooting, "expected_xg", 0), n90s);

      // Shots conceded /90 — use provided sh_90 if available, else compute
      const shots90 =
        pickN(t.shooting, "standard_sh_90", 0) ||
        safePer90(pickN(t.shooting, "standard_sh", 0), n90s);

      // Opp touches in box conceded /90
      const boxTouch90 = safePer90(pickN(t.possession, "touches_att_pen", 0), n90s);

      // Passes into penalty area allowed /90
      const ppa90 = safePer90(pickN(t.passing, "ppa", 0), n90s);

      // Crosses allowed /90 (prefer per90 from rate we stored earlier, else compute per 90)
      // In league blob we only have total crosses; scale by n90s to get per90
      const crosses90 = safePer90(pickN(t.pass_types, "pass_types_crs", 0), n90s);

      // Opp progression per90 (progressive pass dist + progressive carry dist per90)
      const progPassDist90 = safePer90(pickN(t.passing, "total_prgdist", 0), n90s);
      const progCarryDist90 = safePer90(pickN(t.possession, "carries_prgdist", 0), n90s);
      const oppProgDist90 = progPassDist90 + progCarryDist90;

      rows.push({ team, xga90, shots90, boxTouch90, ppa90, crosses90, oppProgDist90 });
    }
    return rows;
  }, [fbrefVs]);

  // Normalize to 0–1 and invert so 1 = better (lower conceded volumes → higher score)
  const defenseLeague = useMemo(() => {
    if (!defenseRaw.length) return null;
    const metrics = [
      { key: "xga90",         label: "xGA/90" },
      { key: "shots90",       label: "Shots Conceded/90" },
      { key: "boxTouch90",    label: "Opp Box Touches/90" },
      { key: "ppa90",         label: "Passes into Box/90" },
      { key: "crosses90",     label: "Crosses Allowed/90" },
      { key: "oppProgDist90", label: "Opp Progression Dist/90" },
    ];

    const mins = {}, maxs = {};
    metrics.forEach(({ key }) => {
      const vals = defenseRaw.map(r => Number(r[key]) || 0);
      mins[key] = Math.min(...vals);
      maxs[key] = Math.max(...vals);
    });

    const norm = (v, mn, mx) => {
      const d = mx - mn;
      if (!Number.isFinite(v)) return 0;
      if (d <= 0) return 0.5;
      return (v - mn) / d; // 0..1 higher = worse volume
    };

    const data = defenseRaw.map(r => {
      const out = { team: r.team };
      metrics.forEach(({ key }) => { out[key] = 1 - norm(r[key], mins[key], maxs[key]); });
      return out;
    });

    return { data, metrics };
  }, [defenseRaw]);

  const defenseRadarData = useMemo(() => {
    if (!selectedTeam || !defenseLeague?.data?.length) return [];
    const row = defenseLeague.data.find(d => d.team === selectedTeam);
    if (!row) return [];
    return defenseLeague.metrics.map(m => ({ metric: m.label, value: Number(row[m.key]) || 0 }));
  }, [defenseLeague, selectedTeam]);

  // Card renderer; each player clickable to open PlayersModal
  function LeadersCard({ title, items, statKey, fmt = (v) => v }) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-2 text-sm font-semibold">{title}</div>
        {items.length === 0 ? (
          <div className="text-sm text-zinc-500">No data.</div>
        ) : (
          <ol className="space-y-2">
            {items.map((p) => (
              <li key={`${title}-${p.id}`}>
                <button
                  type="button"
                  onClick={() => onOpenPlayer?.(p.team, p.id)}
                  className="group flex w-full items-center justify-between gap-2 rounded-md border border-transparent px-2 py-1.5 text-left hover:border-zinc-300 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:hover:bg-zinc-900"
                  title={`Open ${p.player}`}
                >
                  <div className="flex items-center gap-2">
                    <img
                      src={logoUrl(p.team)}
                      alt=""
                      className="h-6 w-6 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
                      onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
                    />
                    <div className="leading-tight">
                      <div className="text-sm font-medium group-hover:underline">{p.player}</div>
                      <div className="text-[11px] text-zinc-500">{p.team}</div>
                    </div>
                  </div>
                  <div className="text-sm font-semibold tabular-nums">{fmt(p[statKey])}</div>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  }

  return (
    <section id="league-analysis" className="mx-auto mt-10 w-full max-w-6xl px-4 md:px-6">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img
            src="/logos/epl.png"
            alt=""
            className="h-8 w-8 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
            onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
          />
          <div>
            <h2 className="text-lg font-semibold">League Data Analysis</h2>
            <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              {loadingDetails && <Spinner />}
              {loadingDetails
                ? "Loading team detail…"
                : (errDetails ? "Some team details failed to load" : "All teams compared")}
            </div>
          </div>
        </div>
      </div>

      {/* Team selector pills */}
      <div className="mb-4 rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-2 text-sm font-semibold">Select team scope</div>
        <div className="flex flex-wrap gap-2">
          <TeamPill label="All teams" active={!selectedTeam} onClick={() => setSelectedTeam("")} logo="/logos/epl.png" />
          {standings.map((r) => (
            <TeamPill key={r.Team} label={r.Team} logo={logoUrl(r.Team)} active={selectedTeam === r.Team} onClick={() => setSelectedTeam(r.Team)} />
          ))}
        </div>
      </div>

      {/* Style & Effectiveness */}
      <Panel title="Style & Effectiveness" help={HELP.insights}>
        {!selectedRow ? (
          <div className="text-sm text-zinc-600 dark:text-zinc-300">Select a team above to see their style of play and effectiveness.</div>
        ) : (
          <div
            className="rounded-xl p-4 shadow-sm ring-1 backdrop-blur"
            style={{ background: `linear-gradient(135deg, ${rgba(themeColor, 0.12)}, transparent 65%)`, borderColor: rgba(themeColor, 0.35) }}
          >
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="flex items-center gap-3">
                <img
                  src={logoUrl(selectedRow.Team)}
                  alt=""
                  className="h-10 w-10 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
                  onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
                />
                <div>
                  <div className="text-base font-semibold">{selectedRow.Team}</div>
                  <div className="text-xs text-zinc-500">Quick view of identity &amp; impact</div>
                </div>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 md:ml-auto md:w-auto md:justify-end justify-end">
                {insightTags}
              </div>
            </div>

            {selectedKpis ? (
              <>
                {/* KPI Gauges (team vs league avg) */}
                <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4">
                  <KpiGauge
                    label="Finishing (G/xG)"
                    value={selectedKpis.finishRatio}
                    avg={leagueAvg?.finishRatio ?? 1}
                    min={kpiDomains.finishing[0]}
                    max={kpiDomains.finishing[1]}
                    better="higher"
                    fmt={fmtNum}
                    color={vis.stroke}
                    size="md"
                  />
                  <KpiGauge
                    label="Box Shot Share"
                    value={selectedKpis.boxShare}
                    avg={leagueAvg?.boxShare ?? 50}
                    min={kpiDomains.boxShare[0]}
                    max={kpiDomains.boxShare[1]}
                    better="higher"
                    fmt={fmtPct}
                    color={vis.stroke}
                    size="md"
                  />
                  <KpiGauge
                    label="PPDA (↓ better)"
                    value={selectedKpis.ppda}
                    avg={leagueAvg?.ppda ?? 11}
                    min={kpiDomains.ppda[0]}
                    max={kpiDomains.ppda[1]}
                    better="lower"
                    fmt={fmtNum}
                    color={vis.stroke}
                    size="md"
                  />
                  {selectedFb && (
                    <KpiGauge
                      label="Progressions /90"
                      value={(selectedFb.progPPer90 || 0) + (selectedFb.progCPer90 || 0)}
                      avg={fbrefAvg ? (fbrefAvg.progTotalPer90 || 0) : 0}
                      min={kpiDomains.prog[0]}
                      max={kpiDomains.prog[1]}
                      better="higher"
                      fmt={fmtNum}
                      color={vis.stroke}
                      size="md"
                    />
                  )}
                </div>

                {/* Optional: more gauges if FBref is present */}
                {selectedFb && (
                  <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4">
                    <KpiGauge
                      label="SCA /90"
                      value={selectedFb.sca90}
                      avg={fbrefAvg ? (fbrefAvg.sca90 || 0) : 0}
                      min={kpiDomains.sca90[0]}
                      max={kpiDomains.sca90[1]}
                      better="higher"
                      fmt={fmtNum}
                      color={vis.stroke}
                      size="md"
                    />
                    <KpiGauge
                      label="GCA /90"
                      value={selectedFb.gca90}
                      avg={fbrefAvg ? (fbrefAvg.gca90 || 0) : 0}
                      min={kpiDomains.gca90[0]}
                      max={kpiDomains.gca90[1]}
                      better="higher"
                      fmt={fmtNum}
                      color={vis.stroke}
                      size="md"
                    />
                    <KpiGauge
                      label="Box touches /90"
                      value={selectedFb.boxTouchesPer90 || 0}
                      avg={fbrefAvg ? (fbrefAvg.boxTouchesPer90 || 0) : 0}
                      min={kpiDomains.boxT90[0]}
                      max={kpiDomains.boxT90[1]}
                      better="higher"
                      fmt={fmtNum}
                      color={vis.stroke}
                      size="md"
                    />
                    <KpiGauge label="Dribble success"
                      value={selectedFb.takeOnSuccPct || 0}
                      avg={fbrefAvg ? (fbrefAvg.takeOnSuccPct || 0) : 0}
                      min={kpiDomains.drbSucc[0]} max={kpiDomains.drbSucc[1]}
                      better="higher" 
                      fmt={fmtPct} 
                      color={vis.stroke} 
                      size="md" 
                    />
                  </div>
                )}
              </>
            ) : null}

            {/* ── Style + Defensive Fingerprints (side by side) ── */}
            <div className="mt-3 border-t border-zinc-200 dark:border-zinc-800" />
            <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* ── Style Fingerprint (Radar) ── */}
              <div className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
                <div className="mb-1 flex items-center gap-2">
                  <img
                    src={logoUrl(selectedRow.Team)}
                    alt=""
                    className="h-6 w-6 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
                    onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
                  />
                  <div className="text-sm font-semibold">{selectedRow.Team} — Style Profile</div>
                  <div className="ml-auto text-[11px] text-zinc-500">
                    {fbrefLoading ? "Loading…" : (fbrefErr ? "Partial FBref data" : "Normalized vs league")}
                  </div>
                </div>
                <div className="h-72">
                  <ResponsiveContainer>
                    <RadarChart data={styleRadarData} outerRadius="80%">
                      <PolarGrid />
                      <PolarAngleAxis dataKey="metric" tick={{ fontSize: 12 }} />
                      <PolarRadiusAxis angle={30} domain={[0, 1]} tick={false} />
                      <Radar
                        name={selectedRow.Team}
                        dataKey="value"
                        stroke={vis.stroke}
                        fill={vis.stroke}
                        fillOpacity={0.5}
                        isAnimationActive
                      />
                    </RadarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-1 text-[11px] text-zinc-500">
                  Pressing (duels/90 or inverse PPDA), Possession (%), Progression (prog passes + carries), Creation (GCA/90), Finishing (Goals ÷ xG). Values are scaled 0–1 across the league.
                </div>
              </div>

              {/* ── Defensive Fingerprint (vs_team) ── */}
              <div className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
                <div className="mb-1 flex items-center gap-2">
                  <img
                    src={logoUrl(selectedRow.Team)}
                    alt=""
                    className="h-6 w-6 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
                    onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
                  />
                  <div className="text-sm font-semibold">{selectedRow.Team} — Defensive Profile</div>
                  <div className="ml-auto text-[11px] text-zinc-500">
                    {fbrefLoading ? "Loading…" : (fbrefErr ? "Partial vs-team data" : "Higher = better (normalized)")}
                  </div>
                </div>
                <div className="h-72">
                  <ResponsiveContainer>
                    <RadarChart data={defenseRadarData} outerRadius="80%">
                      <PolarGrid />
                      <PolarAngleAxis dataKey="metric" tick={{ fontSize: 12 }} />
                      <PolarRadiusAxis angle={30} domain={[0, 1]} tick={false} />
                      <Radar
                        name={`${selectedRow.Team} Defense`}
                        dataKey="value"
                        stroke={vis.stroke}
                        fill={vis.stroke}
                        fillOpacity={0.5}
                        isAnimationActive
                      />
                    </RadarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-1 text-[11px] text-zinc-500">
                  Normalized league-wide and invert “against” volumes so bigger polygon ≈ better defensive profile.
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-col items-center gap-2 text-center">
              <button
                onClick={() => onOpenTeam?.(selectedRow.Team)}
                aria-label={`Open ${selectedRow.Team} in Team View`}
                className="
                  group inline-flex w-full sm:w-auto items-center justify-center gap-2
                  rounded-xl bg-indigo-600 px-4 py-2.5 text-white text-sm md:text-base font-semibold
                  shadow-sm ring-1 ring-indigo-500/0
                  hover:bg-indigo-700 hover:ring-indigo-500/20
                  focus:outline-none focus-visible:ring-4 focus-visible:ring-indigo-500/40
                  active:scale-[.99] transition
                "
              >
                <span>Open {selectedRow.Team} in Team View</span>
                <svg
                  className="h-4 w-4 transition-transform duration-200 ease-out group-hover:translate-x-0.5"
                  viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"
                >
                  <path
                    fillRule="evenodd" clipRule="evenodd"
                    d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 111.414-1.414l4 4a1 1 0 010 
                      1.414l-4 4a1 1 0 01-1.414 0z"
                  />
                </svg>
              </button>
            </div>
          </div>
        )}
      </Panel>

      {/* Scatters */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Non-penalty xG vs Non-penalty xGA */}
        <Panel title="Non-penalty xG vs Non-penalty xGA" help={HELP.npx}>
          <div className="h-72">
            <ResponsiveContainer>
              <ScatterChart margin={{ top: 10, right: 12, left: 0, bottom: 30 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" dataKey="npxg" name="NPxG" tick={{ fontSize: 12 }}
                       label={{ value: "Non-penalty xG", position: "insideBottom", offset: -4, fontSize: 12 }} />
                <YAxis type="number" dataKey="npxga" name="NPxGA" tick={{ fontSize: 12 }} allowDecimals={false}
                       label={{ value: "Non-penalty xGA", angle: -90, position: "insideLeft", fontSize: 12 }} />
                <Tooltip content={<ScatterTip xLabel="NPxG" yLabel="NPxGA" fmtX={round2} fmtY={round2} />} />
                <Scatter name="Teams" data={scatNPx} fill="#3B82F6">
                  {scatNPx.map((d, i) => {
                    const sel = d.hl ? themeColor : "#94A3B8";
                    return (
                      <Cell key={i} r={d.r} fillOpacity={d.dim} fill={sel}
                            stroke={d.hl ? rgba(themeColor, 1) : "none"} strokeWidth={d.hl ? 1.2 : 0} />
                    );
                  })}
                  <LabelList dataKey="team" position="top" style={{ fontSize: 10 }} />
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        {/* Pressing Profile */}
        <Panel title="Pressing Profile — PPDA vs Opponent PPDA" help={HELP.press}>
          <div className="h-72">
            <ResponsiveContainer>
              <ScatterChart margin={{ top: 10, right: 12, left: 0, bottom: 30 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" dataKey="ppda" name="PPDA" tick={{ fontSize: 12 }}
                       label={{ value: "PPDA (lower = more pressing)", position: "insideBottom", offset: -4, fontSize: 12 }} />
                <YAxis type="number" dataKey="oppda" name="OPPDA" tick={{ fontSize: 12 }} allowDecimals={false}
                       label={{ value: "Opponent PPDA", angle: -90, position: "insideLeft", fontSize: 12 }} />
                <Tooltip content={<ScatterTip xLabel="PPDA" yLabel="OPPDA" fmtX={round2} fmtY={round2} />} />
                <Scatter name="Teams" data={scatPress} fill="#10B981">
                  {scatPress.map((d, i) => {
                    const sel = d.hl ? themeColor : "#94A3B8";
                    return (
                      <Cell key={i} r={d.r} fillOpacity={d.dim} fill={sel}
                            stroke={d.hl ? rgba(themeColor, 1) : "none"} strokeWidth={d.hl ? 1.2 : 0} />
                    );
                  })}
                  <LabelList dataKey="team" position="top" style={{ fontSize: 10 }} />
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      {/* EXTRA VIS: Finishing vs Defensive Overperformance */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Finishing vs Defensive Overperformance" help={HELP.fin_def}>
          <div className="h-72">
            <ResponsiveContainer>
              <ScatterChart margin={{ top: 20, right: 10, left: 0, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" dataKey="finishing" name="Finishing" tick={{ fontSize: 12 }} domain={[0, "dataMax"]}
                       label={{ value: "Finishing (Goals ÷ xG)", position: "insideBottom", offset: -4, fontSize: 12 }} />
                <YAxis type="number" dataKey="defOver" name="Def. Overperf." tick={{ fontSize: 12 }} allowDecimals={false} domain={[0, "dataMax"]}
                       label={{ value: "Defensive Overperformance (xGA ÷ GA)", angle: -90, position: "insideLeft", fontSize: 12 }} />
                <ReferenceLine x={1} stroke="#A1A1AA" strokeDasharray="4 3" />
                <ReferenceLine y={1} stroke="#A1A1AA" strokeDasharray="4 3" />
                <Tooltip content={<ScatterTip xLabel="Finishing" yLabel="Def. Overperf." fmtX={round2} fmtY={round2} />} />
                <Scatter name="Teams" data={finDef} fill="#8B5CF6">
                  {finDef.map((d, i) => {
                    const sel = d.hl ? themeColor : "#94A3B8";
                    return (
                      <Cell key={i} r={d.r} fillOpacity={d.dim} fill={sel}
                            stroke={d.hl ? rgba(themeColor, 1) : "none"} strokeWidth={d.hl ? 1.2 : 0} />
                    );
                  })}
                  <LabelList dataKey="team" position="top" style={{ fontSize: 10 }} />
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">&gt;1 on both axes suggests clinical finishing and conceding fewer than expected.</div>
        </Panel>

        <Panel title="Goals vs xG — per match" help={HELP.g_xg_scatter}>
          <div className="h-80">
            <ResponsiveContainer>
              <ScatterChart margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" dataKey="xgpm" name="xG/Match" domain={[0, gxg.max]} tick={{ fontSize: 12 }} allowDecimals={false}
                       label={{ value: "xG per match", position: "insideBottom", offset: -4, fontSize: 12 }} />
                <YAxis type="number" dataKey="gpm" name="Goals/Match" domain={[0, gxg.max]} tick={{ fontSize: 12 }} allowDecimals={false}
                       label={{ value: "Goals per match", angle: -90, position: "insideLeft", fontSize: 12 }} />
                <ReferenceLine ifOverflow="extendDomain" segment={[{ x: 0, y: 0 }, { x: gxg.max, y: gxg.max }]} stroke="#A1A1AA" strokeDasharray="4 3" />
                <Tooltip content={<ScatterTip xLabel="xG/Match" yLabel="Goals/Match" fmtX={round2} fmtY={round2} />} />
                <Scatter name="Teams" data={gxg.data} fill="#6366F1">
                  {gxg.data.map((d, i) => {
                    const sel = d.hl ? themeColor : "#94A3B8";
                    return (
                      <Cell key={i} r={d.r} fillOpacity={d.dim} fill={sel}
                            stroke={d.hl ? rgba(themeColor, 1) : "none"} strokeWidth={d.hl ? 1.2 : 0} />
                    );
                  })}
                  <LabelList dataKey="team" position="top" style={{ fontSize: 10 }} />
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>
              <div className="mt-1 text-[11px] text-zinc-500">
                Diagonal = neutral finishing; above = outperforming xG; below = underperforming.
          </div>
        </Panel>
      </div>

      {/* PPDA vs DC */}
      <div className="mt-4 rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        {(() => {
          const pts = teamRows
            .map(r => ({
              team: r.Team, PPDA: Number(r.PPDA) || 0, DC: Number(r.DC) || 0,
              r: selectedTeam ? (r.Team === selectedTeam ? 6 : 3) : 4,
              dim: selectedTeam ? (r.Team === selectedTeam ? 1 : 0.35) : 0.9,
              hl: selectedTeam && r.Team === selectedTeam
            }))
            .filter(p => Number.isFinite(p.PPDA) && Number.isFinite(p.DC));
          if (!pts.length) return <div className="text-sm text-zinc-500">No data.</div>;

          const corr = pearson(pts.map(p => -p.PPDA), pts.map(p => p.DC));
          const xs = pts.map(p => p.PPDA);
          const minX = Math.min(...xs), maxX = Math.max(...xs);
          const { m, b } = linreg(pts.map(p => ({ x: p.PPDA, y: p.DC })));
          const trend = [{ x: minX, y: m * minX + b }, { x: maxX, y: m * maxX + b }];

          const ScatterTT = ({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0]?.payload;
            return (
              <div className="rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
                <div className="font-semibold">{d.team}</div>
                <div>PPDA: <span className="tabular-nums">{d.PPDA.toFixed(2)}</span></div>
                <div>DC: <span className="tabular-nums">{d.DC}</span></div>
              </div>
            );
          };

          return (
            <>
              <div className="h-72">
                <ResponsiveContainer>
                  <ScatterChart margin={{ top: 10, right: 12, left: 4, bottom: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" dataKey="PPDA" name="PPDA" tick={{ fontSize: 12 }} allowDecimals={false}
                           domain={['dataMin', 'dataMax']}
                           label={{ value: "PPDA (lower = more pressing)", position: "insideBottom", offset: -4, fontSize: 12 }} />
                    <YAxis type="number" dataKey="DC" name="DC" tick={{ fontSize: 12 }} allowDecimals={false}
                           domain={['dataMin', 'dataMax']}
                           label={{ value: "Dangerous Chances (DC)", angle: -90, position: "insideLeft", fontSize: 12 }} />
                    <Tooltip content={<ScatterTT />} />
                    <Scatter name="Teams" data={pts} shape="circle">
                      {pts.map((d, i) => {
                        const sel = d.hl ? themeColor : "#94A3B8";
                        return (
                          <Cell key={i} r={d.r} fill={sel} fillOpacity={d.dim}
                                stroke={d.hl ? rgba(themeColor, 1) : "none"} strokeWidth={d.hl ? 1.2 : 0} />
                        );
                      })}
                    </Scatter>
                    <ReferenceLine segment={trend} stroke="#10B981" strokeDasharray="4 3"
                                   label={{ value: "trend", position: "right", fontSize: 10, fill: "#10B981" }} />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                League correlation (more pressing → DC): <span className="tabular-nums font-medium">{corr.toFixed(2)}</span>.
                {selectedTeam ? " Highlighted point is the selected team." : " Select a team to highlight."}
              </div>
            </>
          );
        })()}
      </div>
      {/* ── Metrics: League Leaders ── */}
      <div className="mt-4">
        <Panel title="League Leaders" help="Top scorers, assisters, highest xG and xA.">
          {errLeaders ? (
            <div className="text-sm text-rose-600">Failed to load league leaders.</div>
          ) : (
            <>
              {loadingLeaders ? (
                <div className="text-sm text-zinc-500">Loading leaders…</div>
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
                  <LeadersCard title="Top Scorers" items={leaders.goals}   statKey="goals" />
                  <LeadersCard title="Top Assists" items={leaders.assists} statKey="assists" />
                  <LeadersCard title="Highest xG"  items={leaders.xg}      statKey="xG" fmt={(v)=> (Number(v)||0).toFixed(2)} />
                  <LeadersCard title="Highest xA"  items={leaders.xa}      statKey="xA" fmt={(v)=> (Number(v)||0).toFixed(2)} />
                </div>
              )}
            </>
          )}
        </Panel>
      </div>
    </section>
  );
}

function WeeklyMovementPanel({ apiBase }) {
  const [weeklyData, setWeeklyData] = useState(null);
  const [loadingWeekly, setLoadingWeekly] = useState(false);
  const [errWeekly, setErrWeekly] = useState(null);
  const [hoverTeam, setHoverTeam] = useState(null);
  const [selectedTeam, setSelectedTeam] = useState("");
  const themeColor = useMemo(() => getTeamPrimary(selectedTeam), [selectedTeam]);

  // Load weekly table
  useEffect(() => {
    if (!apiBase) return;
    let stop = false;
    (async () => {
      try {
        setLoadingWeekly(true);
        setErrWeekly(null);
        const json = await fetchJson(`${apiBase}/weekly_table`);
        if (stop) return;
        const data = json?.data || json;
        setWeeklyData(data);
      } catch (e) {
        if (!stop) setErrWeekly(String(e));
      } finally {
        if (!stop) setLoadingWeekly(false);
      }
    })();
    return () => { stop = true; };
  }, [apiBase]);

  const bumpy = useMemo(() => {
    if (!weeklyData?.weeks?.length || !Array.isArray(weeklyData.teams)) return null;
    const weeks = weeklyData.weeks;
    const teamCount = weeklyData.teams.length || 20;
    const series = weeklyData.teams.map(({ team, pos }) => {
      const pts = (pos || []).map((p, i) => ({ week: weeks[i], pos: p, team }));
      return { team, data: pts };
    });
    return { weeks, teamCount, series };
  }, [weeklyData]);

  const bumpyYTicks = useMemo(() => {
    if (!bumpy) return [];
    const N = bumpy.teamCount;
    return Array.from({ length: N }, (_, i) => i + 1);
  }, [bumpy]);

  const ROW_PX = 32;
  const chartHeight = Math.max(560, (bumpy?.teamCount || 20) * ROW_PX);

  const rightLogoPoints = useMemo(() => {
    if (!bumpy) return [];
    const weeks = bumpy.weeks;
    const last = weeks[weeks.length - 1];
    return (bumpy.series || [])
      .map((s) => {
        const lastPt = [...s.data].reverse().find((d) => Number.isFinite(d?.pos));
        const pos = Number(lastPt?.pos);
        if (!Number.isFinite(pos)) return null;
        return { week: last, pos, team: s.team };
      })
      .filter(Boolean);
  }, [bumpy]);

  function BumpyTip({ active, payload, label, hoverTeam }) {
    if (!active || !payload || !payload.length || !hoverTeam) return null;
    const item =
      (hoverTeam && payload.find(p => (p.name || p.dataKey) === hoverTeam)) ||
      payload.find(p => p?.payload?.team) ||
      payload[0];
    if (!item) return null;
    const team = item.name || item?.payload?.team || "";
    const pos  = Number(item.value);
    return (
      <div className="rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="font-semibold">{team}</div>
        <div>Matchweek: <span className="tabular-nums">{label}</span></div>
        <div>Position: <span className="tabular-nums">{pos}</span></div>
      </div>
    );
  }

  const BumpyDot = (props) => {
    const { cx, cy, payload } = props;
    const t = payload?.team;
    const selected = selectedTeam && t === selectedTeam;
    const color = selected ? themeColor : "#64748B";
    const opacity = selectedTeam && !selected ? 0.25 : 1;
    return (
      <circle
        cx={cx}
        cy={cy}
        r={selected ? 3.6 : 2.2}
        fill={color}
        fillOpacity={opacity}
        stroke="#ffffff"
        strokeWidth={0.8}
        onClick={() => setSelectedTeam(t)}
        onMouseEnter={() => setHoverTeam(t)}
        onMouseLeave={() => setHoverTeam(null)}
        style={{ cursor: "pointer" }}
      />
    );
  };

  const LogoShape = (props) => {
    const { cx, cy, payload } = props;
    const team = payload?.team;
    const selected = selectedTeam && team === selectedTeam;
    const dim = selectedTeam && !selected ? 0.35 : 1;
    const tx = (cx ?? 0) - 24;
    const ty = cy ?? 0;
    return (
      <g
        transform={`translate(${tx}, ${ty})`}
        onClick={() => setSelectedTeam((prev) => (prev === team ? "" : team))}
        onMouseEnter={() => setHoverTeam(team)}
        onMouseLeave={() => setHoverTeam(null)}
        style={{ cursor: "pointer", pointerEvents: "all" }}
      >
        {selected ? (
          <rect x={30} y={-12} width={24} height={24} rx={12} ry={12}
                fill="none" stroke={themeColor} strokeWidth={2} />
        ) : null}
        <circle cx={42} cy={0} r={12} fill="#FFFFFF" stroke="#E5E7EB" strokeWidth={1} />
        <image href={logoUrl(team)} xlinkHref={logoUrl(team)} x={30} y={-12} width={24} height={24} opacity={dim} />
        <title>{team}</title>
      </g>
    );
  };

  return (
    <Panel title="Weekly Team League Movement" help={HELP.bumpy}>
      {errWeekly ? (
        <div className="text-sm text-rose-600">Failed to load weekly table.</div>
      ) : (loadingWeekly || !bumpy) ? (
        <div className="text-sm text-zinc-500">Loading weekly table…</div>
      ) : (
        <>
          <div
            style={{ height: chartHeight }}
            className="noselect"
            onMouseDown={(e) => e.preventDefault()}
            onDoubleClick={(e) => e.preventDefault()}
          >
            <ResponsiveContainer>
              <LineChart margin={{ top: 10, right: 96, left: 8, bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  dataKey="week"
                  ticks={bumpy.weeks}
                  domain={[bumpy.weeks[0], bumpy.weeks[bumpy.weeks.length - 1]]}
                  tick={{ fontSize: 12 }}
                  label={{ value: "Matchweek", position: "insideBottom", offset: -4, fontSize: 12 }}
                />
                <YAxis
                  yAxisId="left"
                  type="number"
                  domain={[1, bumpy.teamCount]}
                  reversed
                  ticks={bumpyYTicks}
                  allowDecimals={false}
                  dataKey="pos"
                  padding={{ top: 6, bottom: 6 }}
                  tick={{ fontSize: 10 }}
                  label={{ value: "Table Position (1 = top)", angle: -90, position: "insideLeft", fontSize: 12 }}
                />
                <Tooltip content={(p) => <BumpyTip {...p} hoverTeam={hoverTeam} />} />
                {/* Lines */}
                {bumpy.series
                  .filter(s => !selectedTeam || s.team !== selectedTeam)
                  .map((s) => (
                    <Line
                      key={`line-${s.team}`}
                      yAxisId="left"
                      data={s.data}
                      type="monotone"
                      dataKey="pos"
                      name={s.team}
                      stroke="#94A3B8"
                      strokeOpacity={selectedTeam ? 0.25 : 0.6}
                      strokeWidth={5}
                      dot={<BumpyDot />}
                      isAnimationActive={false}
                      onClick={() => setSelectedTeam(s.team)}
                      onMouseOver={() => setHoverTeam(s.team)}
                      onMouseOut={() => setHoverTeam(null)}
                    />
                  ))}
                {selectedTeam && (() => {
                  const sel = bumpy.series.find(s => s.team === selectedTeam);
                  if (!sel) return null;
                  return (
                    <Line
                      key={`line-selected-${sel.team}`}
                      yAxisId="left"
                      data={sel.data}
                      type="monotone"
                      dataKey="pos"
                      name={sel.team}
                      stroke={themeColor}
                      strokeWidth={3}
                      dot={<BumpyDot />}
                      isAnimationActive={false}
                    />
                  );
                })()}
                <Scatter
                  yAxisId="left"
                  data={rightLogoPoints}
                  isAnimationActive={false}
                  name="logos"
                  shape={LogoShape}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">
            Click a line, dot, or a logo to highlight a team.
          </div>
        </>
      )}
    </Panel>
  );
}

/* ───────────────────────────── Main App ───────────────────────────── */
export default function App() {
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTeamName, setModalTeamName] = useState(null);
  const [resultsModalOpen, setResultsModalOpen] = useState(false);
  const [fixturesModalOpen, setFixturesModalOpen] = useState(false);
  const [matchCenterOpen, setMatchCenterOpen] = useState(false);
  const [activeMatchId, setActiveMatchId] = useState(null);
  const [standings, setStandings] = useState([]);
  const [playersOpen, setPlayersOpen] = useState(false);
  const [playersInitial, setPlayersInitial] = useState(null);
  const [contactOpen, setContactOpen] = useState(false);
  const [activePage, setActivePage] = useState("home");

  // ── Theme (light/dark) ───────────────────────────────────────────
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem("theme");
      if (saved === "dark" || saved === "light") return saved;
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    } catch { return "light"; }
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    try { localStorage.setItem("theme", theme); } catch {}
  }, [theme]);

  const toggleTheme = () => setTheme(t => (t === "dark" ? "light" : "dark"));

  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/standings`, {
          signal: ctrl.signal,
          headers: {"X-API-TOKEN": import.meta.env.VITE_API_TOKEN },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setStandings(Array.isArray(data) ? data : []);
      } catch (e) {
        console.error("Failed to load teams:", e);
      }
    })();
    return () => { cancelled = true; ctrl.abort(); };
  }, [API_BASE]);

  const teams = useMemo(
    () => (standings || []).map((r) => r.Team).filter(Boolean).sort((a, b) => a.localeCompare(b)),
    [standings]
  );

  function openTeam(name) {
    setModalOpen(false); setResultsModalOpen(false); setMatchCenterOpen(false); setFixturesModalOpen(false); setPlayersOpen(false); setContactOpen(false);
    setModalTeamName(name);
    setModalOpen(true);
    setRoute(`#team=${encodeURIComponent(name)}`);
  }
  function openMatch(id) {
    const mid = String(id);
    setActiveMatchId(mid);
    setMatchCenterOpen(true);
    setRoute(`#match=${mid}`);
  }
  function openPlayer(teamName, playerId) {
    const team = typeof teamName === "string" ? teamName : (teamName?.team || "");
    const pid  = playerId != null ? String(playerId) : undefined;
    setPlayersInitial(team ? { team, playerId: pid } : null);
    setPlayersOpen(true);
    // If team available, include in hash for deep-linking
    setRoute(pid ? `#players=${encodeURIComponent(`${team}:${pid}`)}` :
             team ? `#players=${encodeURIComponent(team)}` : "#players");
  }
  function scrollToId(id) {
    const el = document.getElementById(id);
    if (el) { try { el.scrollIntoView({ behavior: "smooth", block: "start" }); } catch { el.scrollIntoView(); } }
  }
  // ────────────────── Lightweight modal <-> URL hash sync ──────────────────
  const setRoute = (hash) => {
    // Avoid duplicate entries when already at hash
    if (window.location.hash === hash) return;
    try { history.pushState({}, "", hash); } catch {}
  };

  const clearRoute = (replace=false) => {
    try {
      if (replace) history.replaceState({}, "", "#");
      else history.pushState({}, "", "#");
    } catch {}
  };

  const applyHash = () => {
    const h = (window.location.hash || "").trim();
    // Close everything first
    setModalOpen(false);
    setResultsModalOpen(false);
    setFixturesModalOpen(false);
    setPlayersOpen(false);
    setMatchCenterOpen(false);
    setContactOpen(false);
    setPlayersInitial(null);
    setActiveMatchId(null);
    setModalTeamName(null);
    setActivePage("home");

    if (!h || h === "#") return;

    // #team=Arsenal
    if (h.startsWith("#team=")) {
      const name = decodeURIComponent(h.slice(6));
      if (name) { setModalTeamName(name); setModalOpen(true); }
      return;
    }
    // #match=12345
    if (h.startsWith("#match=")) {
      const id = h.slice(7);
      if (id) { setActiveMatchId(String(id)); setMatchCenterOpen(true); }
      return;
    }
    // #players (optionally #players=Arsenal or #players=Arsenal:42)
    if (h.startsWith("#players")) {
      const v = h.includes("=") ? h.split("=")[1] : "";
      if (v) {
        const [team, playerId] = decodeURIComponent(v).split(":");
        setPlayersInitial(team ? { team, playerId: playerId ? String(playerId) : undefined } : null);
      }
      setPlayersOpen(true);
      return;
    }
    if (h === "#fixtures") { setFixturesModalOpen(true); return; }
    if (h === "#results")  { setResultsModalOpen(true);  return; }
    if (h === "#contact")  { setContactOpen(true);       return; }
    if (h === "#predictions") { setActivePage("predictions"); return; }
  };

  useEffect(() => {
    // On initial load: open whatever hash points to
    applyHash();
    const onPop = () => applyHash();
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onPop);
    };
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-50 to-white text-zinc-900 dark:from-zinc-950 dark:to-zinc-900 dark:text-zinc-100">
      <style>{`
        .noselect, .noselect * {
          user-select: none;
          -webkit-user-select: none;
          -ms-user-select: none;
          -moz-user-select: none;
          -webkit-tap-highlight-color: transparent;
        }
        /* Remove the black focus rectangle some browsers draw on SVG content */
        .recharts-wrapper svg *:focus { outline: none !important; }
        .recharts-wrapper image { outline: none !important; }
      `}</style>

      <Navbar
        brand="Premier League Dashboard"
        teams={teams}
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenTeam={openTeam}
        onOpenResults={() => { setResultsModalOpen(true); setModalOpen(false); setMatchCenterOpen(false); setFixturesModalOpen(false); setPlayersOpen(false); setContactOpen(false); setRoute("#results"); }}
        onOpenFixtures={() => { setFixturesModalOpen(true); setModalOpen(false); setResultsModalOpen(false); setMatchCenterOpen(false); setPlayersOpen(false); setContactOpen(false); setRoute("#fixtures"); }}
        onOpenPlayers={() => { setPlayersOpen(true); setModalOpen(false); setResultsModalOpen(false); setMatchCenterOpen(false); setFixturesModalOpen(false); setContactOpen(false); setRoute("#players"); }}
        onOpenStandings={() => {
          setModalOpen(false);
          setResultsModalOpen(false);
          setFixturesModalOpen(false);
          setPlayersOpen(false);
          setMatchCenterOpen(false);
          setContactOpen(false);
          setPlayersInitial(null);
          setActiveMatchId(null);
          setModalTeamName(null);
          requestAnimationFrame(() => scrollToId("league-standings"));
        }}
        onOpenPredictions={() => {
          // close any open modals and navigate
          setModalOpen(false); setResultsModalOpen(false); setMatchCenterOpen(false);
          setFixturesModalOpen(false); setPlayersOpen(false); setContactOpen(false);
          setActivePage("predictions");
          setRoute("#predictions");
        }}
        onOpenContact={() => { setContactOpen(true); setModalOpen(false); setResultsModalOpen(false); setMatchCenterOpen(false); setFixturesModalOpen(false); setPlayersOpen(false); setRoute("#contact"); }}
        onGoHome={() => {
          setModalOpen(false); setResultsModalOpen(false); setMatchCenterOpen(false);
          setFixturesModalOpen(false); setPlayersOpen(false); setContactOpen(false);
          setActivePage("home");
          clearRoute(true)
        }}
      />

      <main className="px-4 pt-4 pb-10 md:px-6">
        {activePage === "predictions" ? (
          <PredictionsPage
            apiBase={API_BASE}
            onOpenPlayer={openPlayer}
          />
        ) : (
          <>
            {/* FPL Predictions — CTA */}
            <section className="mx-auto mt-6 w-full max-w-6xl px-4 md:px-6">
              <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
                <div className="flex flex-col items-start justify-between gap-3 md:flex-row md:items-center">
                  <div>
                    <h2 className="text-base font-semibold">FPL Predictions</h2>
                    <p className="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-300">
                      The FPL Predictions tool goes beyond basic gameweek data by training on both historical and current player statistics. 
                      It leverages four different machine learning models — <strong>XGBoost</strong>, <strong>LightGBM</strong>, 
                      <strong>PyTorch MLP</strong>, and <strong>PyTorch LSTM</strong> — to estimate how many points a player might score 
                      in the upcoming gameweek. You can compare results across these models to see how different approaches interpret 
                      the data, giving you multiple perspectives on potential player performance.
                    </p>
                  </div>
                  <div className="shrink-0">
                    <button
                      type="button"
                      onClick={() => { setActivePage("predictions"); setRoute("#predictions"); }}
                      className="inline-flex items-center rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
                      title="Open FPL Predictions"
                    >
                      Open Predictions
                    </button>
                  </div>
                </div>
              </div>
            </section>

        {/* Upcoming fixtures */}
        <section id="upcoming-fixtures" className="mx-auto mt-10 w-full max-w-6xl px-4 md:px-6">
          <div className="mt-8">
            <ResultsFixturesDeck
              apiBase={API_BASE}
              onOpenMatch={openMatch}
              onShowAllResults={() => { setResultsModalOpen(true); setRoute("#results"); }}
              onShowAllFixtures={() => { setFixturesModalOpen(true); setRoute("#fixtures"); }}
            />
          </div>
        </section>

        {/* ── League Data Analysis (inline) ── */}
        <LeagueAnalysisSection apiBase={API_BASE} standings={standings} teams={teams} onOpenTeam={openTeam} onOpenPlayer={openPlayer} isDark={theme === "dark"} />

        {/* Standings */}
        <h2 id="league-standings" className="mb-4 mt-8 text-center text-2xl font-semibold tracking-tight">
          Premier League Standings
        </h2>
        <div className="flex justify-center">
          <div className="w-full max-w-4xl">
            <StandingsTable
              rows={standings}  
              onOpenTeam={openTeam} />
          </div>
        </div>
        {/* Weekly movement placed below standings */}
        <div className="mx-auto mt-4 w-full max-w-6xl">
          <WeeklyMovementPanel apiBase={API_BASE} />
        </div>
        </>
        )}
      </main>

      <SiteFooter ownerName={OWNER_NAME} />

      {/* Contact Modal */}
      <ContactModal
        open={contactOpen}
        onClose={() => setContactOpen(false)}
        ownerName={OWNER_NAME}
        ownerTitle={OWNER_TITLE}
        ownerIntro={OWNER_INTRO}
        contact={CONTACT}
      />

      {/* Team modal */}
      <TeamModal
        open={modalOpen}
        team={null}
        teamName={modalTeamName}
        apiBase={API_BASE}
        standingsEndpoint={`${API_BASE}/standings`}
        teamColors={TEAM_COLORS}
        onClose={() => setModalOpen(false)}
        onOpenMatch={openMatch}
        onOpenPlayer={(teamName, player) => {
          setPlayersInitial({ team: teamName, playerId: String(player.id) });
          setPlayersOpen(true);
        }}
      />

      {/* Played matches list modal */}
      <ResultsListModal
        open={resultsModalOpen}
        apiBase={API_BASE}
        teams={teams}
        onClose={() => setResultsModalOpen(false)}
        onOpenMatch={openMatch}
      />

      {/* Upcoming Fixtures modal */}
      <FixturesListModal
        open={fixturesModalOpen}
        apiBase={API_BASE}
        teams={teams}
        onClose={() => setFixturesModalOpen(false)}
        onOpenMatch={openMatch}
      />

      {/* Players */}
      <PlayersModal
        open={playersOpen}
        apiBase={API_BASE}
        teams={teams}
        onClose={() => {
          setPlayersOpen(false);
          setPlayersInitial(null);
        }}
        initialTeam={playersInitial?.team}
        initialPlayerId={playersInitial?.playerId}
      />

      {/* Match Center */}
      <MatchCenter open={matchCenterOpen} matchId={activeMatchId} apiBase={API_BASE} onClose={() => setMatchCenterOpen(false)} />
    </div>
  );
}

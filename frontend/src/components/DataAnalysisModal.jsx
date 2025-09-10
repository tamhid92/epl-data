// components/DataAnalysisModal.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import ModalFrame from "./ModalFrame";
import {
  ResponsiveContainer,
  ScatterChart, Scatter,
  XAxis, YAxis,
  CartesianGrid, Tooltip, Cell, LabelList,
  ReferenceLine
} from "recharts";


const API_TOKEN = import.meta.env.VITE_API_TOKEN;
/* ---------------- utilities ---------------- */
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

/* tiny hover helper */
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
          <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 2-3 4"/><line x1="12" y1="17" x2="12" y2="17"/>
        </svg>
        <span className="pointer-events-none absolute left-1/2 top-[125%] z-30 hidden w-64 -translate-x-1/2 rounded-md border border-zinc-200 bg-white px-2.5 py-2 text-[11px] leading-snug text-zinc-700 shadow-lg group-hover:block dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
          {text}
        </span>
      </button>
    </span>
  );
}

const HELP = {
  npx: "Non-penalty xG (x-axis) vs Non-penalty xGA (y-axis). Bottom-right is best: create a lot, concede little.",
  press: "Pressing profile: PPDA (lower = more aggressive pressing) vs Opponent PPDA.",
  g_xg_scatter: "Goals per match (y) vs xG per match (x). Above the diagonal = finishing above xG.",
  zones: "Three mini-scatters: For% (x) vs Against% (y) share of xG by location.",
  insights: "Team style & effectiveness inferred from pressing (PPDA), shot zone mix, creation sources, timing, and finishing vs xG.",
  ppda_dc: "PPDA: passes per defensive action (lower = more pressing). DC: dangerous chances created. A downward trend from left to right would suggest that more pressing is associated with generating more dangerous chances."
};

/* style tags */
function Tag({ children, tone = "default" }) {
  const cls =
    tone === "good" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
    : tone === "warn" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
    : tone === "bad"  ? "bg-rose-500/15 text-rose-700 dark:text-rose-300"
    : "bg-zinc-500/10 text-zinc-700 dark:text-zinc-300";
  return <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", cls)}>{children}</span>;
}

/* custom scatter tooltip with team name */
function ScatterTip({ active, payload, xLabel = "X", yLabel = "Y", fmtX = (v)=>v, fmtY=(v)=>v }) {
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

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  let sx=0, sy=0, sxx=0, syy=0, sxy=0;
  for (let i=0;i<n;i++){
    const x = Number(xs[i]) || 0;
    const y = Number(ys[i]) || 0;
    sx += x; sy += y; sxx += x*x; syy += y*y; sxy += x*y;
  }
  const cov = sxy - (sx*sy)/n;
  const vx = sxx - (sx*sx)/n;
  const vy = syy - (sy*sy)/n;
  if (vx <= 0 || vy <= 0) return 0;
  return cov / Math.sqrt(vx*vy);
}

function linreg(xy) {
  const n = xy.length;
  if (n < 2) return { m: 0, b: 0 };
  let sx=0, sy=0, sxx=0, sxy=0;
  for (const {x, y} of xy) {
    const X = Number(x) || 0, Y = Number(y) || 0;
    sx += X; sy += Y; sxx += X*X; sxy += X*Y;
  }
  const m = (n*sxy - sx*sy) / Math.max(1e-9, (n*sxx - sx*sx));
  const b = (sy - m*sx) / n;
  return { m, b };
}

/* ---------------- main modal ---------------- */
export default function DataAnalysisModal({ open, apiBase, teams = [], onClose, onOpenTeam }) {
  const closeRef = useRef(null);

  // data
  const [standings, setStandings] = useState([]);
  const [loadingStandings, setLoadingStandings] = useState(false);
  const [errStandings, setErrStandings] = useState(null);

  const [createdMap, setCreatedMap] = useState({});
  const [concededMap, setConcededMap] = useState({});
  const [zonesMap, setZonesMap] = useState({});
  const [zonesConMap, setZonesConMap] = useState({});
  const [timingMap, setTimingMap] = useState({});

  const [loadingDetails, setLoadingDetails] = useState(false);
  const [errDetails, setErrDetails] = useState(null);

  // UI
  const [selectedTeam, setSelectedTeam] = useState(""); // "" = All

  useEffect(() => { if (open && closeRef.current) closeRef.current.focus(); }, [open]);

  // standings
  useEffect(() => {
    if (!open || !apiBase) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        setLoadingStandings(true);
        setErrStandings(null);
        const data = await fetchJson(`${apiBase}/standings`, { signal: ctrl.signal });
        setStandings(Array.isArray(data) ? data : []);
      } catch (e) {
        if (e.name !== "AbortError") setErrStandings(String(e));
      } finally {
        setLoadingStandings(false);
      }
    })();
    return () => ctrl.abort();
  }, [open, apiBase]);

  // per-team details
  useEffect(() => {
    if (!open || !apiBase) return;
    const ts = (standings?.length ? standings.map(r => r.Team) : teams) || [];
    if (!ts.length) return;

    let cancelled = false;
    (async () => {
      try {
        setLoadingDetails(true);
        setErrDetails(null);
        const MAX_CONC = 5;
        const queue = [...ts];
        const _c = {}, _ca = {}, _z = {}, _za = {}, _t = {};
        async function loadTeam(t) {
          try {
            const [created, conceded, zones, zonesCon, timing] = await Promise.all([
              fetchJson(`${apiBase}/chances_created/${encodeURIComponent(t)}`),
              fetchJson(`${apiBase}/chances_conceded/${encodeURIComponent(t)}`),
              fetchJson(`${apiBase}/shot_zone/${encodeURIComponent(t)}`),
              fetchJson(`${apiBase}/shot_zone_conceded/${encodeURIComponent(t)}`),
              fetchJson(`${apiBase}/timing/${encodeURIComponent(t)}`),
            ]);
            _c[t] = Array.isArray(created) ? created : [];
            _ca[t] = Array.isArray(conceded) ? conceded : [];
            _z[t] = Array.isArray(zones) ? zones : [];
            _za[t] = Array.isArray(zonesCon) ? zonesCon : [];
            _t[t] = Array.isArray(timing) ? timing : [];
          } catch { /* ignore single-team failure */ }
        }
        const workers = Array.from({ length: Math.min(MAX_CONC, queue.length) }, async () => {
          while (queue.length && !cancelled) await loadTeam(queue.shift());
        });
        await Promise.all(workers);
        if (cancelled) return;
        setCreatedMap(_c); setConcededMap(_ca); setZonesMap(_z); setZonesConMap(_za); setTimingMap(_t);
      } catch (e) {
        if (!cancelled) setErrDetails(String(e));
      } finally {
        if (!cancelled) setLoadingDetails(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, apiBase, standings, teams]);

  /* -------- derived per-team rows -------- */
  const teamRows = useMemo(() => {
    const s = Array.isArray(standings) ? standings : [];
    return s.map((r) => {
      const t = r.Team;
      const created = createdMap[t] || [];
      const conceded = concededMap[t] || [];
      const zones = zonesMap[t] || [];
      const zc = zonesConMap[t] || [];
      const timing = timingMap[t] || [];

      const openFor = by(created, "OpenPlay", 0);
      const openAg  = by(conceded, "OpenPlay", 0);
      const corFor  = by(created, "FromCorner", 0);
      const corAg   = by(conceded, "FromCorner", 0);
      const penFor  = by(created, "Penalty", 0);
      const penAg   = by(conceded, "Penalty", 0);

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
        PPDA: num(r.PPDA), OPPDA: num(r.OPPDA),
        DC: num(r.DC),

        // situations
        xG_open_for: openFor, xG_open_ag: openAg,
        xG_corner_for: corFor, xG_corner_ag: corAg,
        xG_pen_for: penFor, xG_pen_ag: penAg,
        xG_created_total: openFor + corFor + penFor,

        // zones (shares)
        six_for_pct: pct(sixFor, zxg), pen_for_pct: pct(penForX, zxg), obox_for_pct: pct(obFor, zxg),
        six_ag_pct: pct(sixAg, zcxg),  pen_ag_pct: pct(penAgX, zcxg),  obox_ag_pct: pct(obAg, zcxg),

        // timing
        xG_early: sum(early, "xG"), xG_late: sum(late, "xG"),
      };
    });
  }, [standings, createdMap, concededMap, zonesMap, zonesConMap, timingMap]);

  /* -------- visuals data (keep all points; highlight selection) -------- */

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

  /* -------- insights for selected team -------- */
  const insights = useMemo(() => {
    if (!selectedTeam) return null;
    const r = teamRows.find((x) => x.Team === selectedTeam);
    if (!r) return null;

    const tags = [];
    if (r.PPDA <= 9) tags.push(<Tag key="press-hi" tone="good">High press</Tag>);
    else if (r.PPDA >= 12) tags.push(<Tag key="press-low">Mid/low block</Tag>);
    if (r.OPPDA <= 10) tags.push(<Tag key="opp-pressed" tone="good">Forces rushed buildup</Tag>);
    const boxShare = r.six_for_pct + r.pen_for_pct;
    if (boxShare >= 70) tags.push(<Tag key="boxy" tone="good">Box-centric shots</Tag>);
    if (r.obox_for_pct >= 35) tags.push(<Tag key="long" tone="warn">Long-shot heavy</Tag>);
    const createdTotal = r.xG_created_total || 0.0001;
    if (r.xG_corner_for / createdTotal > 0.28) tags.push(<Tag key="set" tone="warn">Set-piece reliant</Tag>);
    if (r.xG_late >= r.xG_early) tags.push(<Tag key="late" tone="good">Strong closers</Tag>);
    else tags.push(<Tag key="early">Fast starters</Tag>);
    const finishRatio = r.xG > 0 ? r.G / r.xG : 1;
    if (finishRatio >= 1.1 && r.xG > 2) tags.push(<Tag key="clinical" tone="good">Clinical finishing</Tag>);
    if (finishRatio <= 0.9 && r.xG > 2) tags.push(<Tag key="cold" tone="bad">Underperforming chances</Tag>);
    if (r.NPxGD / Math.max(1, r.M) >= 0.5) tags.push(<Tag key="dom" tone="good">Territorial dominance</Tag>);

    const summary = [
      `Pressing: PPDA ${round2(r.PPDA)}, Opponent PPDA ${round2(r.OPPDA)}.`,
      `Shot mix: Six-yard ${round2(r.six_for_pct)}%, Penalty Area ${round2(r.pen_for_pct)}%, Outside Box ${round2(r.obox_for_pct)}% of attacking xG.`,
      `Creation (xG): Open Play ${round2(r.xG_open_for)}, Corners ${round2(r.xG_corner_for)}, Pens ${round2(r.xG_pen_for)}.`,
      `Timing: xG early ${round2(r.xG_early)} vs late ${round2(r.xG_late)}.`,
      `Effectiveness: Goals ${r.G} vs xG ${round2(r.xG)}; NP-xGD ${round2(r.NPxGD)}.`,
    ].join(" ");

    return { tags, summary };
  }, [selectedTeam, teamRows]);

  function openTeamFromAnalysis(team) {
    onClose?.();
    setTimeout(() => onOpenTeam?.(team), 0);
  }

  if (!open) return null;

  /* ---------------- render ---------------- */
  return (
    <ModalFrame open={open} onClose={onClose} maxWidth="max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          <img
            src="/logos/epl.png"
            alt=""
            className="h-8 w-8 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
            onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
          />
          <div>
            <h2 className="text-lg font-semibold">League Data Analysis</h2>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              {loadingStandings || loadingDetails ? "Loading…" : "All teams compared"}
              {errStandings ? " • standings failed" : ""}
              {errDetails ? " • some details failed" : ""}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {selectedTeam ? (
            <button
              onClick={() => openTeamFromAnalysis(selectedTeam)}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
              title={`Open ${selectedTeam}`}
            >
              Open Team
            </button>
          ) : null}
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
      <div className="grow min-h-0 space-y-6 overflow-y-auto p-4">
        {/* Team selector pills */}
        <section className="rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold">Select team scope</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <TeamPill
              label="All teams"
              active={!selectedTeam}
              onClick={() => setSelectedTeam("")}
              logo="/logos/epl.png"
            />
            {standings.map((r) => (
              <TeamPill
                key={r.Team}
                label={r.Team}
                logo={logoUrl(r.Team)}
                active={selectedTeam === r.Team}
                onClick={() => setSelectedTeam(r.Team)}
              />
            ))}
          </div>
        </section>

        {/* Style & Effectiveness */}
        <section>
          <Panel title="Style & Effectiveness" help={HELP.insights}>
            {!selectedTeam ? (
              <div className="text-sm text-zinc-600 dark:text-zinc-300">
                Select a team above to see their style of play and effectiveness.
              </div>
            ) : insights ? (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">{insights.tags}</div>
                <p className="text-sm text-zinc-700 dark:text-zinc-200">{insights.summary}</p>
                <div>
                  <button
                    onClick={() => openTeamFromAnalysis(selectedTeam)}
                    className="mt-2 inline-flex items-center rounded-lg border border-indigo-400 px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50 dark:border-indigo-700 dark:text-indigo-200 dark:hover:bg-indigo-900/20"
                  >
                    Open {selectedTeam} in Team View
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-sm text-zinc-600 dark:text-zinc-300">No insight available.</div>
            )}
          </Panel>
        </section>

        {/* Row: NP-xG vs NP-xGA and Pressing */}
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Non-penalty xG vs Non-penalty xGA" help={HELP.npx}>
            <div className="h-72">
              <ResponsiveContainer>
                <ScatterChart margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" dataKey="npxg" name="NPxG" tick={{ fontSize: 12 }} />
                  <YAxis type="number" dataKey="npxga" name="NPxGA" tick={{ fontSize: 12 }} allowDecimals={false} />
                  <Tooltip content={<ScatterTip xLabel="NPxG" yLabel="NPxGA" fmtX={round2} fmtY={round2} />} />
                  <Scatter name="Teams" data={scatNPx} fill="#3B82F6">
                    {scatNPx.map((d, i) => (
                      <Cell
                        key={i}
                        r={d.r}
                        fillOpacity={d.dim}
                        fill={d.hl ? "#3B82F6" : "#94A3B8"}
                        stroke={d.hl ? "#0EA5E9" : "none"}
                        strokeWidth={d.hl ? 1.2 : 0}
                      />
                    ))}
                    <LabelList dataKey="team" position="top" style={{ fontSize: 10 }} />
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel title="Pressing Profile — PPDA vs Opponent PPDA" help={HELP.press}>
            <div className="h-72">
              <ResponsiveContainer>
                <ScatterChart margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" dataKey="ppda" name="PPDA" tick={{ fontSize: 12 }} />
                  <YAxis type="number" dataKey="oppda" name="OPPDA" tick={{ fontSize: 12 }} allowDecimals={false} />
                  <Tooltip content={<ScatterTip xLabel="PPDA" yLabel="OPPDA" fmtX={round2} fmtY={round2} />} />
                  <Scatter name="Teams" data={scatPress} fill="#10B981">
                    {scatPress.map((d, i) => (
                      <Cell
                        key={i}
                        r={d.r}
                        fillOpacity={d.dim}
                        fill={d.hl ? "#10B981" : "#94A3B8"}
                        stroke={d.hl ? "#0EA5E9" : "none"}
                        strokeWidth={d.hl ? 1.2 : 0}
                      />
                    ))}
                    <LabelList dataKey="team" position="top" style={{ fontSize: 10 }} />
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        </section>

        {/* Goals vs xG per match (scatter) */}
        <section>
          <Panel title="Goals vs xG — per match" help={HELP.g_xg_scatter}>
            <div className="h-80">
              <ResponsiveContainer>
                <ScatterChart margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" dataKey="xgpm" name="xG/Match" domain={[0, gxg.max]} tick={{ fontSize: 12 }} allowDecimals={false}/>
                  <YAxis type="number" dataKey="gpm"  name="Goals/Match" domain={[0, gxg.max]} tick={{ fontSize: 12 }} allowDecimals={false} />
                  <ReferenceLine ifOverflow="extendDomain" segment={[{ x: 0, y: 0 }, { x: gxg.max, y: gxg.max }]} stroke="#A1A1AA" strokeDasharray="4 3" />
                  <Tooltip content={<ScatterTip xLabel="xG/Match" yLabel="Goals/Match" fmtX={round2} fmtY={round2} />} />
                  <Scatter name="Teams" data={gxg.data} fill="#6366F1">
                    {gxg.data.map((d, i) => (
                      <Cell
                        key={i}
                        r={d.r}
                        fillOpacity={d.dim}
                        fill={d.hl ? "#6366F1" : "#94A3B8"}
                        stroke={d.hl ? "#0EA5E9" : "none"}
                        strokeWidth={d.hl ? 1.2 : 0}
                      />
                    ))}
                    <LabelList dataKey="team" position="top" style={{ fontSize: 10 }} />
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
              <div className="mt-1 text-[11px] text-zinc-500">Diagonal = neutral finishing; above = outperforming xG; below = underperforming.</div>
            </div>
          </Panel>
        </section>

        {/* Shot Location Profile — triptych with axis labels */}
        <section>
          <Panel title="Shot Location Profile — For% vs Against% by zone" help={HELP.zones}>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <ZoneQuadrant title="Six-yard box" data={zoneTriptych} fx="sixF" fy="sixA" good="top-left" selectedTeam={selectedTeam} />
              <ZoneQuadrant title="Penalty area" data={zoneTriptych} fx="penF" fy="penA" good="top-left" selectedTeam={selectedTeam} />
              <ZoneQuadrant title="Outside box" data={zoneTriptych} fx="obF"  fy="obA"  good="bottom-right" selectedTeam={selectedTeam} />
            </div>
          </Panel>
        </section>

        {/* PPDA vs DC — pressing → dangerous chances? */}
        <section className="rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-1 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">PPDA vs DC — Does pressing create more dangerous chances?</h3>
              <HelpHint text={HELP.ppda_dc} />
            </div>
            {selectedTeam ? (
              <button
                onClick={() => openTeamFromAnalysis(selectedTeam)}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
              >
                Open {selectedTeam}
              </button>
            ) : null}
          </div>

          {(() => {
            const pts = teamRows
              .map(r => ({
                team: r.Team,
                PPDA: Number(r.PPDA) || 0,
                DC: Number(r.DC) || 0,
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
            const trend = [
              { x: minX, y: m * minX + b },
              { x: maxX, y: m * maxX + b },
            ];

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
                      <XAxis
                        type="number"
                        dataKey="PPDA"
                        name="PPDA"
                        tick={{ fontSize: 12 }}
                        allowDecimals={false}
                        domain={['dataMin', 'dataMax']}
                        label={{ value: "PPDA (lower = more pressing)", position: "insideBottom", offset: -4, fontSize: 12 }}
                      />
                      <YAxis
                        type="number"
                        dataKey="DC"
                        name="DC"
                        tick={{ fontSize: 12 }}
                        allowDecimals={false}
                        domain={['dataMin', 'dataMax']}
                        label={{ value: "Dangerous Chances (DC)", angle: -90, position: "insideLeft", fontSize: 12 }}
                      />
                      <Tooltip content={<ScatterTT />} />
                      <Scatter name="Teams" data={pts} shape="circle">
                        {pts.map((d, i) => (
                          <Cell
                            key={i}
                            r={d.r}
                            fill={d.hl ? "#F59E0B" : "#94A3B8"}
                            fillOpacity={d.dim}
                            stroke={d.hl ? "#0EA5E9" : "none"}
                            strokeWidth={d.hl ? 1.2 : 0}
                          />
                        ))}
                      </Scatter>
                      <ReferenceLine
                        segment={trend}
                        stroke="#10B981"
                        strokeDasharray="4 3"
                        label={{ value: "trend", position: "right", fontSize: 10, fill: "#10B981" }}
                      />
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
        </section>
      </div>
    </ModalFrame>
  );
}

/* ---------------- presentational bits ---------------- */
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
          ? "border-indigo-500 bg-indigo-50/60 text-indigo-800 dark:border-indigo-400 dark:bg-indigo-900/20 dark:text-indigo-100"
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

/* mini quadrant scatter for a single zone */
function ZoneQuadrant({ title, data, fx, fy, good, selectedTeam }) {
  const d = data.map((r) => ({
    team: r.team,
    x: r[fx],
    y: r[fy],
    r: selectedTeam ? (r.team === selectedTeam ? 6 : 3) : 4,
    dim: selectedTeam ? (r.team === selectedTeam ? 1 : 0.35) : 0.9,
    hl: selectedTeam && r.team === selectedTeam
  }));

  return (
    <div className="rounded-xl border border-zinc-200 p-2 dark:border-zinc-800">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-xs font-semibold">{title}</div>
        <div className="text-[10px] text-zinc-500">{good} is good</div>
      </div>
      <div className="h-64">
        <ResponsiveContainer>
          <ScatterChart margin={{ top: 6, right: 6, left: 6, bottom: 6 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              type="number"
              domain={[0, 100]}
              dataKey="x"
              tick={{ fontSize: 10 }}
              tickFormatter={(v) => `${Math.round(v)}%`}
              label={{ value: "For% of xG", position: "insideBottom", offset: -2, fontSize: 10 }}
            />
            <YAxis
              type="number"
              domain={[0, 100]}
              dataKey="y"
              tick={{ fontSize: 10 }}
              tickFormatter={(v) => `${Math.round(v)}%`}
              allowDecimals={false}
              label={{ value: "Against% of xG", angle: -90, position: "insideLeft", fontSize: 10 }}
            />
            <ReferenceLine ifOverflow="extendDomain" segment={[{ x: 0, y: 0 }, { x: 100, y: 100 }]} stroke="#A1A1AA" strokeDasharray="4 3" />
            <Tooltip content={<ScatterTip xLabel="For%" yLabel="Against%" fmtX={(v)=>`${Math.round(v)}%`} fmtY={(v)=>`${Math.round(v)}%`} />} />
            <Scatter name="Teams" data={d} fill="#14B8A6">
              {d.map((p, i) => (
                <Cell
                  key={i}
                  r={p.r}
                  fillOpacity={p.dim}
                  fill={p.hl ? "#14B8A6" : "#94A3B8"}
                  stroke={p.hl ? "#0EA5E9" : "none"}
                  strokeWidth={p.hl ? 1.2 : 0}
                />
              ))}
              <LabelList dataKey="team" position="top" style={{ fontSize: 9 }} />
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

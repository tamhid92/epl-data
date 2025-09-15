// components/PlayersModal.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import ModalFrame from "./ModalFrame";
import {
  ResponsiveContainer,
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
  RadialBarChart, RadialBar,
  PieChart, Pie, Legend
} from "recharts";
import { HelpCircle, Filter as FilterIcon, Search as SearchIcon, Shield, User2 } from "lucide-react";

const API_TOKEN = import.meta.env.VITE_API_TOKEN;

/* ---------- tiny click-to-open helper (mobile-friendly) ---------- */
function HelpHint({ text, className = "" }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`relative inline-flex items-center ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center justify-center rounded-full p-0.5 text-zinc-500 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:text-zinc-400 dark:hover:text-zinc-200"
        aria-label="What is this?"
        title={text}
      >
        <HelpCircle className="h-4 w-4" />
      </button>
      {open && (
        <span
          className="absolute left-1/2 top-[120%] z-30 w-64 -translate-x-1/2 rounded-md border border-zinc-200 bg-white px-2.5 py-2 text-[11px] leading-snug text-zinc-700 shadow-lg dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
          onClick={() => setOpen(false)}
        >
          {text}
        </span>
      )}
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
  Goals: "Goals scored.",
  Assists: "Assists credited.",
  xG: "Expected Goals: shot quality independent of finishing.",
  xA: "Expected Assists: pass quality leading to shots.",
  "xG/90": "Expected Goals per 90 minutes.",
  "xA/90": "Expected Assists per 90 minutes.",
  "Shots/90": "Shots taken per 90.",
  "KP/90": "Key passes per 90 (passes leading directly to a shot).",
  "xGBuildup/90": "Non-shot involvement in shot-ending moves (excludes shots & key passes).",
  "xGChain/90": "Any involvement in shot-ending moves (includes shots & key passes).",
  "xG/90 percentile": "Percentile vs league peers (position-aware).",
  "xA/90 percentile": "Percentile vs league peers (position-aware).",
  "Percentile bars": "Where the player ranks vs peers for core per-90 metrics.",
  "Profile Radar": "Percentile profile across per-90 metrics.",
  "SCA vs GCA": "Shot-Creating Actions (SCA) and Goal-Creating Actions (GCA) per 90 from FBref.",
  "SCA Types": "How the player creates shots: passes (live/dead), dribbles (take-ons), shots creating rebounds, fouls won, or defensive actions.",
  "Passing Accuracy": "Completion % by pass distance (short/medium/long).",
  "Dead vs Live": "Share of passes taken from dead-ball situations (free kicks, corners) vs live play.",
  "Progression Split": "How the player advances the ball: progressive passes vs progressive carries per 90.",
  "Touches Map": "Where the player is most involved: touches by third & penalty areas (normalized).",
  "Shooting Profile": "Shooting volume/accuracy per 90 and average shot distance.",
  "Defensive Activity": "Tackles+Interceptions, blocks per 90 and duel/tackle success.",
};

/* ---------- FBref player parser ---------- */
function parseFbrefPlayer(raw) {
  const node = Array.isArray(raw) ? raw[0] : raw;
  const root = node?.get_player_all_stats || node || {};
  const fb = root.fbref || {};
  const std = fb.standard || {};
  const shoot = fb.shooting || {};
  const gsc = fb.goal_and_shot_creation || {};
  const pass = fb.passing || {};
  const ptype = fb.pass_types || {};
  const poss = fb.possession || {};
  const def = fb.defensive || {};

  const n90 = num(std.playing_time_90s || 0) || 0;
  const div = (a, b) => (b > 0 ? a / b : 0);

  const totalPass =
    num(pass.total_att) ||
    (num(pass.short_att) + num(pass.medium_att) + num(pass.long_att));

  const pct = (n, d) => (d > 0 ? (n / d) * 100 : 0);

  const t_def3 = num(poss.touches_def_3rd);
  const t_mid3 = num(poss.touches_mid_3rd);
  const t_att3 = num(poss.touches_att_3rd);
  const t_attPen = num(poss.touches_att_pen);
  const t_defPen = num(poss.touches_def_pen);
  const t_live = num(poss.touches_live);
  const touchSum = t_def3 + t_mid3 + t_att3 + t_attPen + t_defPen || 1;

  return {
    n90,
    sca90: num(gsc.sca_sca90 || (num(gsc.sca_sca) && n90 ? gsc.sca_sca / n90 : 0)),
    gca90: num(gsc.gca_gca90 || (num(gsc.gca_gca) && n90 ? gsc.gca_gca / n90 : 0)),
    sca_types: {
      passlive: num(gsc.sca_types_passlive || 0),
      passdead: num(gsc.sca_types_passdead || 0),
      drib: num(gsc.sca_types_to || 0),
      sh: num(gsc.sca_types_sh || 0),
      fld: num(gsc.sca_types_fld || 0),
      def: num(gsc.sca_types_def || 0),
    },
    cmpPctShort: num(pass.short_cmppct || 0),
    cmpPctMed: num(pass.medium_cmppct || 0),
    cmpPctLong: num(pass.long_cmppct || 0),
    kp: num(pass.kp || 0),
    prgp: num(pass.prgp || 0),
    deadShare: pct(num(ptype.pass_types_dead || 0), totalPass),
    cross: num(ptype.pass_types_crs || 0),
    sw: num(ptype.pass_types_sw || 0),
    tb: num(ptype.pass_types_tb || 0),
    progPass90: div(num(pass.prgp || 0), n90),
    progCarry90: div(num(poss.carries_prgc || 0), n90),
    touchShare: {
      DefPen: (t_defPen / touchSum) * 100,
      Def3: (t_def3 / touchSum) * 100,
      Mid3: (t_mid3 / touchSum) * 100,
      Att3: (t_att3 / touchSum) * 100,
      AttPen: (t_attPen / touchSum) * 100,
    },
    touchesLive: t_live,
    sh90: num(shoot.standard_sh_90 || (num(shoot.standard_sh) && n90 ? shoot.standard_sh / n90 : 0)),
    sot90: num(shoot.standard_sot_90 || (num(shoot.standard_sot) && n90 ? shoot.standard_sot / n90 : 0)),
    sotPct: num(shoot.standard_sotpct || 0),
    dist: num(shoot.standard_dist || 0),
    pk: num(shoot.standard_pk || 0),
    pkatt: num(shoot.standard_pkatt || 0),
    tklInt90: div(num(def.tklplusint || 0), n90),
    blocks90: div(num(def.blocks_blocks || 0), n90),
    duelWinPct: num(def.challenges_tklpct || 0),
    tklThirds90: {
      Def3: div(num(def.tackles_def_3rd || 0), n90),
      Mid3: div(num(def.tackles_mid_3rd || 0), n90),
      Att3: div(num(def.tackles_att_3rd || 0), n90),
    },
  };
}

/* ---------- main ---------- */
export default function PlayersModal({
  open,
  apiBase,
  teams = [],
  onClose,
  initialTeam,
  initialPlayerId,
  initialPlayerName,
}) {
  const closeRef = useRef(null);

  // All players across league (Understat list)
  const [allPlayers, setAllPlayers] = useState([]);
  const [loadingAll, setLoadingAll] = useState(false);
  const [errAll, setErrAll] = useState(null);

  // Filters (shared mobile & desktop)
  const [teamFilter, setTeamFilter] = useState("");
  const [posFilter, setPosFilter] = useState("");
  const [query, setQuery] = useState("");

  // Selected player id
  const [selectedId, setSelectedId] = useState(null);
  const selected = useMemo(
    () => allPlayers.find((p) => String(p.id) === String(selectedId)) || null,
    [allPlayers, selectedId]
  );

  // FBref player details (fetched per selected player name)
  const [fbPlayer, setFbPlayer] = useState(null);
  const [loadingFb, setLoadingFb] = useState(false);

  // Adopt preselect when opening
  useEffect(() => {
    if (!open) return;
    setTeamFilter(initialTeam || "");
    setPosFilter("");
    setQuery("");
    if (initialPlayerId) setSelectedId(String(initialPlayerId));
  }, [open, initialTeam, initialPlayerId]);

  // Fetch everyone (concurrent by team), prioritizing the initial team
  useEffect(() => {
    if (!open || !apiBase || !teams?.length) return;
    let cancelled = false;

    (async () => {
      try {
        setLoadingAll(true);
        setErrAll(null);

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
            // ignore single team failure
          }
        }

        const workers = Array.from({ length: Math.min(MAX_CONC, queue.length) }, async () => {
          while (queue.length && !cancelled) {
            const t = queue.shift();
            await run(t);
            if (cancelled) return;
            setAllPlayers((prev) => {
              const seen = new Set(prev.map((p) => `${p.team}|${p.id}`));
              const newOnes = results.filter((p) => !seen.has(`${p.team}|${p.id}`));
              const out = [...prev, ...newOnes];
              out.sort((a, b) => b.time - a.time);
              return out;
            });
          }
        });

        await Promise.all(workers);
        if (cancelled) return;

        setAllPlayers((prev) => {
          const out = [...prev];
          out.sort((a, b) => b.time - a.time);
          return out;
        });

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

  // Visible set by filter & search
  const filtered = useMemo(() => {
    let arr = allPlayers;
    if (teamFilter) arr = arr.filter((p) => p.team === teamFilter);
    if (posFilter)  arr = arr.filter((p) => p._bucket === posFilter);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      arr = arr.filter((p) =>
        p.player_name.toLowerCase().includes(q) ||
        p.team.toLowerCase().includes(q)
      );
    }
    return arr;
  }, [allPlayers, teamFilter, posFilter, query]);

  // Ensure selection stays in sync with filters
  useEffect(() => {
    if (!open) return;
    if (!filtered.length) { setSelectedId(null); return; }
    const stillVisible = filtered.some((p) => String(p.id) === String(selectedId));
    if (!stillVisible) setSelectedId(filtered[0].id);
  }, [filtered, open]); // eslint-disable-line react-hooks/exhaustive-deps

  // FBref fetch for selected player (by name)
  useEffect(() => {
    if (!open) return;
    const name = selected?.player_name;
    if (!name || !apiBase) { setFbPlayer(null); return; }

    let cancelled = false;
    (async () => {
      try {
        setLoadingFb(true);
        const raw = await fetchJson(`${apiBase}/fbref/player/${encodeURIComponent(name)}`);
        if (cancelled) return;
        setFbPlayer(parseFbrefPlayer(raw));
      } catch {
        if (!cancelled) setFbPlayer(null); // silent fallback
      } finally {
        if (!cancelled) setLoadingFb(false);
      }
    })();

    return () => { cancelled = true; };
  }, [open, apiBase, selected?.player_name]);

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

  const playerOptions = filtered.map((p) => ({ id: p.id, label: `${p.player_name} — ${p.team}` }));

  return (
    <ModalFrame open={open} onClose={onClose} maxWidth="max-w-6xl">
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

        <button
          ref={closeRef}
          onClick={() => { try { history.back(); } catch { onClose?.(); } }}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
        >
          Close
        </button>
      </div>

      {/* Unified Filter Bar (desktop + mobile) */}
      <div className="sticky top-0 z-10 border-b border-zinc-200 bg-white/70 backdrop-blur p-3 dark:border-zinc-800 dark:bg-zinc-950/70">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-12">
          {/* Team */}
          <div className="md:col-span-4">
            <div className="flex items-center gap-2 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
              <Shield className="h-4 w-4 opacity-70" />
              <select
                value={teamFilter}
                onChange={(e) => { setTeamFilter(e.target.value); }}
                className="w-full bg-transparent outline-none"
                title="Filter by team"
              >
                <option value="">All teams</option>
                {teams.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          {/* Position */}
          <div className="md:col-span-2">
            <div className="flex items-center gap-2 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
              <User2 className="h-4 w-4 opacity-70" />
              <select
                value={posFilter}
                onChange={(e) => { setPosFilter(e.target.value); }}
                className="w-full bg-transparent outline-none"
                title="Filter by position"
              >
                <option value="">All positions</option>
                <option value="GK">GK</option>
                <option value="D">D</option>
                <option value="M">M</option>
                <option value="F">F</option>
              </select>
            </div>
          </div>

          {/* Search */}
          <div className="md:col-span-3">
            <label className="flex items-center gap-2 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
              <SearchIcon className="h-4 w-4 opacity-70" />
              <input
                value={query}
                onChange={(e) => { setQuery(e.target.value); }}
                placeholder="Search player or team…"
                className="w-full bg-transparent outline-none"
              />
            </label>
          </div>

          {/* Player selector */}
          <div className="md:col-span-3">
            <div className="flex items-center gap-2 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
              <FilterIcon className="h-4 w-4 opacity-70" />
              <select
                value={selectedId || ""}
                onChange={(e) => setSelectedId(e.target.value || null)}
                className="w-full bg-transparent outline-none"
                title="Select player"
              >
                <option value="" disabled>
                  {playerOptions.length ? "Choose a player…" : "No players match your filters"}
                </option>
                {playerOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="max-h-[calc(100vh-230px)] overflow-y-auto p-4">
        {/* Details & visuals only (more room!) */}
        <div className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800">
          {!selected ? (
            <p className="text-sm text-zinc-500">Use the filters above to choose a player.</p>
          ) : (
            <PlayerDetails
              p={selected}
              fb={fbPlayer}
              loadingFb={loadingFb}
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
function PlayerDetails({ p, pct, fb, loadingFb }) {
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

  // --- FBref derived datasets (if available) ---
  const scaVsGca = useMemo(() => {
    if (!fb) return [];
    return [
      { k: "SCA/90", v: fb.sca90, color: "#10B981" },
      { k: "GCA/90", v: fb.gca90, color: "#F59E0B" },
    ];
  }, [fb]);

  const scaTypesPie = useMemo(() => {
    if (!fb) return [];
    const t = fb.sca_types || {};
    const order = [
      { key: "passlive", label: "Pass (live)", c: "#3B82F6" },
      { key: "passdead", label: "Pass (dead)", c: "#6366F1" },
      { key: "drib", label: "Dribble", c: "#22C55E" },
      { key: "sh", label: "Shot (rebound)", c: "#EF4444" },
      { key: "fld", label: "Fouled", c: "#F97316" },
      { key: "def", label: "Defensive", c: "#A855F7" },
    ];
    return order
      .map((o) => ({ name: o.label, value: num(t[o.key] || 0), fill: o.c }))
      .filter((x) => x.value > 0);
  }, [fb]);

  const passCmpData = useMemo(() => {
    if (!fb) return [];
    return [
      { k: "Short", v: fb.cmpPctShort, c: "#10B981" },
      { k: "Medium", v: fb.cmpPctMed, c: "#22D3EE" },
      { k: "Long", v: fb.cmpPctLong, c: "#F43F5E" },
    ];
  }, [fb]);

  const deadLivePie = useMemo(() => {
    if (!fb) return [];
    const dead = Math.max(0, Math.min(100, fb.deadShare || 0));
    const live = Math.max(0, 100 - dead);
    return [
      { name: "Live play", value: live, fill: "#0EA5E9" },
      { name: "Dead-ball", value: dead, fill: "#A78BFA" },
    ];
  }, [fb]);

  const progSplit = useMemo(() => {
    if (!fb) return [];
    return [
      { k: "Prog passes /90", v: fb.progPass90, c: "#0EA5E9" },
      { k: "Prog carries /90", v: fb.progCarry90, c: "#84CC16" },
    ];
  }, [fb]);

  const touchesByZone = useMemo(() => {
    if (!fb) return [];
    const t = fb.touchShare || {};
    return [
      { k: "Def Pen", v: t.DefPen || 0, c: "#64748B" },
      { k: "Def 1/3", v: t.Def3 || 0, c: "#60A5FA" },
      { k: "Middle 1/3", v: t.Mid3 || 0, c: "#22C55E" },
      { k: "Att 1/3", v: t.Att3 || 0, c: "#F59E0B" },
      { k: "Att Pen", v: t.AttPen || 0, c: "#EF4444" },
    ];
  }, [fb]);

  const shootingProfile = useMemo(() => {
    if (!fb) return [];
    return [
      { k: "Shots/90", v: fb.sh90, c: "#0EA5E9" },
      { k: "SoT/90", v: fb.sot90, c: "#10B981" },
      { k: "SoT%", v: fb.sotPct, c: "#A78BFA", isPct: true },
      { k: "Avg dist (m)", v: fb.dist, c: "#F97316" },
    ];
  }, [fb]);

  const defensiveBoard = useMemo(() => {
    if (!fb) return { rows: [], thirds: [] };
    return {
      rows: [
        { label: "Tkl+Int /90", v: fb.tklInt90, c: "#8B5CF6", max: 8 },
        { label: "Blocks /90", v: fb.blocks90, c: "#64748B", max: 6 },
        { label: "Duel Win%", v: fb.duelWinPct, c: "#22C55E", max: 100, isPct: true },
      ],
      thirds: [
        { k: "Def 1/3", v: fb.tklThirds90?.Def3 || 0, c: "#60A5FA" },
        { k: "Mid 1/3", v: fb.tklThirds90?.Mid3 || 0, c: "#22C55E" },
        { k: "Att 1/3", v: fb.tklThirds90?.Att3 || 0, c: "#F59E0B" },
      ]
    };
  }, [fb]);

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

      {/* percentile bars */}
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

      {/* ───────────────────────── FBref STORY PANELS ───────────────────────── */}
      {(loadingFb || fb) && (
        <div className="space-y-4">
          {/* SCA vs GCA + SCA Types */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800 md:col-span-1">
              <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
                <span>Creation (FBref)</span>
                <HelpHint text={HELP["SCA vs GCA"]} />
              </div>
              {loadingFb ? (
                <div className="text-sm text-zinc-500">Loading…</div>
              ) : !fb ? (
                <div className="text-sm text-zinc-500">No FBref player data.</div>
              ) : (
                <div className="h-40">
                  <ResponsiveContainer>
                    <BarChart data={scaVsGca} margin={{ left: 16, right: 8, top: 8, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="k" tick={{ fontSize: 12 }} />
                      <YAxis />
                      <Tooltip formatter={(v) => [fmt2(v), "per 90"]} />
                      <Bar dataKey="v" radius={[6, 6, 0, 0]}>
                        {scaVsGca.map((d, i) => <Cell key={i} fill={d.color} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800 md:col-span-2">
              <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
                <span>SCA Types Breakdown</span>
                <HelpHint text={HELP["SCA Types"]} />
              </div>
              {loadingFb ? (
                <div className="text-sm text-zinc-500">Loading…</div>
              ) : !fb || !scaTypesPie.length ? (
                <div className="text-sm text-zinc-500">No SCA type data.</div>
              ) : (
                <div className="h-40">
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie data={scaTypesPie} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="90%" paddingAngle={2}>
                        {scaTypesPie.map((s, i) => <Cell key={i} fill={s.fill} />)}
                      </Pie>
                      <Tooltip formatter={(v, n) => [v, n]} />
                      <Legend verticalAlign="bottom" height={24} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>

          {/* Passing: accuracy ladder + dead vs live */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800 md:col-span-2">
              <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
                <span>Passing Accuracy by Distance</span>
                <HelpHint text={HELP["Passing Accuracy"]} />
              </div>
              {loadingFb ? (
                <div className="text-sm text-zinc-500">Loading…</div>
              ) : !fb ? (
                <div className="text-sm text-zinc-500">No FBref passing data.</div>
              ) : (
                <div className="h-44">
                  <ResponsiveContainer>
                    <BarChart data={passCmpData} margin={{ left: 16, right: 12, top: 8, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="k" />
                      <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                      <Tooltip formatter={(v) => [`${fmt2(v)}%`, "Cmp%"]} />
                      <Bar dataKey="v" radius={[6, 6, 0, 0]}>
                        {passCmpData.map((d, i) => <Cell key={i} fill={d.c} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800 md:col-span-1">
              <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
                <span>Dead vs Live Share</span>
                <HelpHint text={HELP["Dead vs Live"]} />
              </div>
              {loadingFb ? (
                <div className="text-sm text-zinc-500">Loading…</div>
              ) : !fb ? (
                <div className="text-sm text-zinc-500">No FBref pass-type data.</div>
              ) : (
                <div className="h-44">
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie data={deadLivePie} dataKey="value" nameKey="name" innerRadius="60%" outerRadius="90%" paddingAngle={3}>
                        {deadLivePie.map((s, i) => <Cell key={i} fill={s.fill} />)}
                      </Pie>
                      <Tooltip formatter={(v, n) => [`${fmt2(v)}%`, n]} />
                      <Legend verticalAlign="bottom" height={24} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>

          {/* Progression split + Touches by zone */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800 md:col-span-1">
              <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
                <span>Progression Split</span>
                <HelpHint text={HELP["Progression Split"]} />
              </div>
              {loadingFb ? (
                <div className="text-sm text-zinc-500">Loading…</div>
              ) : !fb ? (
                <div className="text-sm text-zinc-500">No FBref progression data.</div>
              ) : (
                <div className="h-40">
                  <ResponsiveContainer>
                    <BarChart data={progSplit} margin={{ left: 16, right: 12, top: 8, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="k" />
                      <YAxis />
                      <Tooltip formatter={(v) => [fmt2(v), "per 90"]} />
                      <Bar dataKey="v" radius={[6, 6, 0, 0]}>
                        {progSplit.map((d, i) => <Cell key={i} fill={d.c} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800 md:col-span-2">
              <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
                <span>Touches by Zone (share)</span>
                <HelpHint text={HELP["Touches Map"]} />
              </div>
              {loadingFb ? (
                <div className="text-sm text-zinc-500">Loading…</div>
              ) : !fb ? (
                <div className="text-sm text-zinc-500">No FBref touches data.</div>
              ) : (
                <div className="h-44">
                  <ResponsiveContainer>
                    <BarChart data={touchesByZone} margin={{ left: 16, right: 12, top: 8, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="k" />
                      <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                      <Tooltip formatter={(v) => [`${fmt2(v)}%`, "Share"]} />
                      <Bar dataKey="v" radius={[6, 6, 0, 0]}>
                        {touchesByZone.map((d, i) => <Cell key={i} fill={d.c} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>

          {/* Shooting + Defensive */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800 md:col-span-2">
              <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
                <span>Shooting Profile</span>
                <HelpHint text={HELP["Shooting Profile"]} />
              </div>
              {loadingFb ? (
                <div className="text-sm text-zinc-500">Loading…</div>
              ) : !fb ? (
                <div className="text-sm text-zinc-500">No FBref shooting data.</div>
              ) : (
                <div className="h-44">
                  <ResponsiveContainer>
                    <BarChart data={shootingProfile} margin={{ left: 16, right: 12, top: 8, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="k" />
                      <YAxis />
                      <Tooltip
                        formatter={(v, n, obj) => [
                          obj.payload.isPct ? `${fmt2(v)}%` : fmt2(v),
                          obj.payload.isPct ? "Rate" : "Value",
                        ]}
                      />
                      <Bar dataKey="v" radius={[6, 6, 0, 0]}>
                        {shootingProfile.map((d, i) => <Cell key={i} fill={d.c} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              {fb && (fb.pkatt || fb.pk) ? (
                <div className="mt-1 text-[11px] text-zinc-500">
                  Penalties: {fb.pk} / {fb.pkatt} converted.
                </div>
              ) : null}
            </div>

            <div className="rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800 md:col-span-1">
              <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
                <span>Defensive Activity</span>
                <HelpHint text={HELP["Defensive Activity"]} />
              </div>
              {loadingFb ? (
                <div className="text-sm text-zinc-500">Loading…</div>
              ) : !fb ? (
                <div className="text-sm text-zinc-500">No FBref defensive data.</div>
              ) : (
                <>
                  <div className="h-40">
                    <ResponsiveContainer>
                      <BarChart
                        data={defensiveBoard.rows}
                        layout="vertical"
                        margin={{ left: 24, right: 12, top: 8, bottom: 0 }}
                      >
                        <CartesianGrid horizontal vertical={false} strokeDasharray="3 3" />
                        <XAxis
                          type="number"
                          domain={[0, (dataMax) => Math.max(dataMax, 100)]}
                          tickFormatter={(v, idx) => (idx === 2 ? `${v}%` : v)}
                        />
                        <YAxis dataKey="label" type="category" tick={{ fontSize: 11 }} width={92} />
                        <Tooltip
                          formatter={(v, n, obj) => [
                            obj.payload.isPct ? `${fmt2(v)}%` : fmt2(v),
                            n,
                          ]}
                        />
                        <Bar dataKey="v" radius={[6, 6, 6, 6]}>
                          {defensiveBoard.rows.map((d, i) => <Cell key={i} fill={d.c} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-2 h-36">
                    <ResponsiveContainer>
                      <BarChart data={defensiveBoard.thirds} margin={{ left: 16, right: 12, top: 8, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="k" />
                        <YAxis />
                        <Tooltip formatter={(v) => [fmt2(v), "per 90"]} />
                        <Bar dataKey="v" radius={[6, 6, 0, 0]}>
                          {defensiveBoard.thirds.map((d, i) => <Cell key={i} fill={d.c} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
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

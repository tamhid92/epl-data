// PredictionsPage.jsx
import React, { useEffect, useMemo, useState } from "react";

/* ============================== Helpers ============================== */

// Numeric helpers
const num = (v) => (Number.isFinite(+v) ? +v : 0);
const round1 = (v) => (Number.isFinite(+v) ? Math.round(v * 10) / 10 : 0);

// Team-name preference (use canonical -> fallback1 -> fallback2 -> default)
const pickTeamNameForLogo = (t1, t2, t3) => String(t1 || t2 || t3 || "_default");

// --- Team name normalization for logo filenames / routing ---
const TEAM_LOGO_ALIASES = {
  // Newcastle
  "newcastle": "Newcastle United",
  "newcastle utd": "Newcastle United",
  "newcastle united": "Newcastle United",
  // Nottingham Forest
  "nott'm forest": "Nottingham Forest",
  "nott’m forest": "Nottingham Forest",
  "nottingham forest": "Nottingham Forest",
  "nottingham": "Nottingham Forest",
};

function normalizeTeamNameForLogo(raw) {
  const n = String(raw || "").trim();
  if (!n) return "_default";
  const key = n.toLowerCase();
  return TEAM_LOGO_ALIASES[key] || n; // fall back to original if not aliased
}

// Build logo URL using normalized team name
const logoUrl = (teamName) =>
  `/logos/${encodeURIComponent(normalizeTeamNameForLogo(teamName))}.png`;

// color chips
function Badge({ children, tone = "zinc" }) {
  const map = {
    zinc: "bg-zinc-100 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200",
    green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
    blue: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
    red: "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200",
    violet: "bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-200",
    indigo: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200",
    slate: "bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-200",
  }[tone] || "";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${map}`}>
      {children}
    </span>
  );
}

function MobilePredictionCard({ r, findElementForPrediction, openPlayerNormalized, logoUrl, pickTeamNameForLogo, normalizeTeamNameForLogo, diffCardBg, venuePillClass, round1, num }) {
  const playerName = r.matched_player_name || r.name || "Unknown";
  const teamName = normalizeTeamNameForLogo(
    pickTeamNameForLogo(
      r.matched_team_name || r.canonical_team_name,
      r.matched_team_from_catalog,
      r.team
    )
  );
  const oppName = r.canonical_opponent_name || "";
  const diff = r.next_opponent_difficulty ?? null;
  const venue = (() => {
    const ex = String(r.explanation || "");
    if (/away/i.test(ex)) return "AWAY";
    if (/home/i.test(ex)) return "HOME";
    return null;
  })();
  const pts = num(r.predicted_total_points);
  const el = findElementForPrediction(r);
  const price = el ? (num(el.now_cost) / 10).toFixed(1) : null;
  const owner = el ? parseFloat(el.selected_by_percent || 0) : null;
  const factors = (r.top_factors ? String(r.top_factors).split(";").map(s => s.trim()).filter(Boolean) : []).slice(0, 6);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      {/* Row 1: Avatar + Player + Team + Price */}
      <div className="flex items-center gap-3">
        <img
          src={logoUrl(teamName)}
          alt=""
          className="h-8 w-8 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
          onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
        />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="block truncate text-sm font-semibold hover:underline"
            title="Open player"
            onClick={() => {
              const id = r.understat_id ?? r.element ?? r.fbref_id;
              if (id != null) openPlayerNormalized(teamName, String(id));
            }}
          >
            {playerName}
          </button>
          <div className="text-[11px] text-zinc-500">
            {teamName} • {r.position || "—"} • {r.next_gameweek ? `GW${r.next_gameweek}` : "GW—"}
          </div>
        </div>

        <div className="text-right">
          {price ? <div className="text-sm font-medium tabular-nums">£{price}</div> : <div className="text-sm text-zinc-400">—</div>}
          {owner != null && (
            <div className="text-[11px] text-zinc-500">Sel {owner.toFixed(1)}%</div>
          )}
        </div>
      </div>

      {/* Row 2: Opponent card + Projected */}
      <div className="mt-3 flex items-center justify-between gap-3">
        <div
          className={`relative flex min-w-0 flex-1 items-center gap-2 rounded-lg p-2 ${diffCardBg(diff)}`}
        >
          {venue && (
            <span className={`absolute -top-1.5 -right-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ring-1 ring-white/40 ${venuePillClass(venue)}`}>
              {venue === "HOME" ? "H" : "A"}
            </span>
          )}
          <img
            src={logoUrl(oppName || teamName)}
            alt=""
            className="h-6 w-6 rounded bg-white object-contain ring-1 ring-white/50"
            onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
          />
          <div className="min-w-0">
            <div className="truncate text-[12px] font-medium">{oppName || "—"}</div>
            {diff != null && (
              <div className="text-[11px] opacity-80">Fixture Difficulty:  {diff}</div>
            )}
          </div>
        </div>

        <div className="shrink-0 rounded-lg border border-zinc-300 px-2 py-1 text-sm font-semibold tabular-nums dark:border-zinc-700">
          {round1(pts)} pts
        </div>
      </div>

      {/* Row 3: Factors (horizontal scroll chips) */}
      <div className="mt-2 -mx-1 flex gap-1.5 overflow-x-auto pb-1">
        {factors.length ? (
          factors.map((f, i) => (
            <span key={i} className="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">
              {f}
            </span>
          ))
        ) : (
          <span className="text-xs text-zinc-400">No factor breakdown.</span>
        )}
      </div>
    </div>
  );
}


const MODEL_OPTIONS = [
  { key: "lgb",  label: "LightGBM" },
  { key: "xgb",  label: "XGBoost" },
  { key: "lstm", label: "PyTorch LSTM" },
  { key: "mlp",  label: "PyTorch MLP" },
];

const MODEL_DESC = {
  lgb: `Gradient-boosted trees tuned for structured FPL data. Learns non-linear links between ICT/xGI, fixture difficulty, minutes odds, and price to produce strong, fast rankings across positions.`,
  xgb: `Regularized boosting focused on stability. Similar to LightGBM but with stronger regularization that smooths noisy targets (e.g., pen saves, cameo goals) for steadier week-to-week projections.`,
  mlp: `Feed-forward neural net that “mixes” many signals at once (role, opponent style, set pieces, rest days, travel/turnaround, team strength splits). Captures subtle cross-feature interactions trees may flatten.`,
  lstm: `Sequence model over recent gameweeks that reads form/momentum and context (minutes ramp after injury, tactical role shifts, congested schedules). Treats a player’s history as an ordered timeline, not independent rows.`,
};

// Opponent difficulty card bg
const diffCardBg = (d) => {
  switch (Number(d)) {
    case 1: return "bg-emerald-200 dark:bg-emerald-900/50";
    case 2: return "bg-teal-200 dark:bg-teal-900/50";
    case 3: return "bg-amber-200 dark:bg-amber-900/50";
    case 4: return "bg-orange-200 dark:bg-orange-900/50";
    case 5: return "bg-rose-300 dark:bg-rose-900/60";
    default: return "bg-zinc-200 dark:bg-zinc-800";
  }
};

const venuePillClass = (v) =>
  v === "HOME"
    ? "bg-emerald-600 text-white"
    : "bg-indigo-600 text-white";

// Parse factors string into chips
const chipsFromTopFactors = (str) =>
  (str ? String(str).split(";").map((s) => s.trim()).filter(Boolean).slice(0, 8) : []);

// Venue inference helpers
function inferVenue(explanation) {
  const ex = String(explanation || "");
  if (/away/i.test(ex)) return "AWAY";
  if (/home/i.test(ex)) return "HOME";
  return null;
}

// Safe unified opener for modal/hash
function makeOpenPlayerNormalized(onOpenPlayer) {
  return function openPlayerNormalized(teamRaw, idRaw) {
    const team = normalizeTeamNameForLogo(teamRaw);
    const pid = String(idRaw ?? "");
    if (typeof onOpenPlayer === "function") {
      return onOpenPlayer(team, pid);
    }
    if (typeof window !== "undefined") {
      const t = encodeURIComponent(team);
      const i = encodeURIComponent(pid);
      window.location.hash = `players=${t}:${i}`;
    }
  };
}

/* ============================== Component ============================== */

export default function PredictionsPage({ apiBase = "/api", onOpenPlayer }) {
  const BOOT_URL =
    (import.meta.env?.VITE_FPL_BOOTSTRAP_URL && String(import.meta.env.VITE_FPL_BOOTSTRAP_URL)) ||
    `${apiBase.replace(/\/$/, "")}/fpl_bootstrap`;

  // data state
  const [bootLoading, setBootLoading] = useState(false);
  const [bootErr, setBootErr] = useState(null);
  const [boot, setBoot] = useState(null);

  const [predLoading, setPredLoading] = useState(false);
  const [predErr, setPredErr] = useState(null);
  const [predRows, setPredRows] = useState([]);

  // model & filters
  const [model, setModel] = useState("lgb");
  const [modelMae, setModelMae] = useState(null);

  const [q, setQ] = useState("");
  const [team, setTeam] = useState("");
  const [pos, setPos] = useState("");
  const [limit, setLimit] = useState(100);

  const openPlayerNormalized = useMemo(() => makeOpenPlayerNormalized(onOpenPlayer), [onOpenPlayer]);

  /* ---------- fetch bootstrap once ---------- */
  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        setBootLoading(true);
        setBootErr(null);
        const headers = {};
        const token = import.meta.env?.VITE_API_TOKEN;
        if (token) headers["X-API-TOKEN"] = token;

        const res = await fetch(BOOT_URL, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();

        // your local endpoint wraps it as [{ fpl_bootstrap: { ... } }]
        const payload =
          Array.isArray(json) && json[0] && json[0].fpl_bootstrap ? json[0].fpl_bootstrap : json;

        if (!ignore) setBoot(payload || null);
      } catch (e) {
        if (!ignore) setBootErr(String(e));
      } finally {
        if (!ignore) setBootLoading(false);
      }
    })();
    return () => { ignore = true; };
  }, [BOOT_URL]);

  /* ---------- fetch predictions on model change ---------- */
  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        setPredLoading(true);
        setPredErr(null);
        const headers = {};
        const token = import.meta.env?.VITE_API_TOKEN;
        if (token) headers["X-API-TOKEN"] = token;

        const base = apiBase.replace(/\/$/, "");
        const url = `${base}/fpl_predict_${model}`;
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const rows = Array.isArray(data) ? data : [];
        const mae = rows.length && rows[0]?.validation_mae != null ? Number(rows[0].validation_mae) : null;

        if (!ignore) {
          setPredRows(rows);
          setModelMae(mae);
        }
      } catch (e) {
        if (!ignore) {
          setPredErr(String(e));
          setPredRows([]);
          setModelMae(null);
        }
      } finally {
        if (!ignore) setPredLoading(false);
      }
    })();
    return () => { ignore = true; };
  }, [apiBase, model]);

  /* ---------- bootstrap shards ---------- */
  const elements = boot?.elements || [];
  const events = boot?.events || [];

  const elementById = useMemo(() => {
    const m = new Map();
    for (const e of elements) m.set(Number(e.id), e);
    return m;
  }, [elements]);

  const elementByUnderstat = useMemo(() => {
    const m = new Map();
    for (const e of elements) if (e.understat_id != null) m.set(String(e.understat_id), e);
    return m;
  }, [elements]);

  const elementByFbref = useMemo(() => {
    const m = new Map();
    for (const e of elements) if (e.fbref_id != null) m.set(String(e.fbref_id), e);
    return m;
  }, [elements]);

  const elementByNameTeam = useMemo(() => {
    const m = new Map();
    for (const e of elements) {
      const key = `${String(e.player_name_normalized || e.web_name || `${e.first_name} ${e.second_name}`).trim().toLowerCase()}__${String(e.canonical_team_name || e.team_norm || e.team).trim().toLowerCase()}`;
      if (!m.has(key)) m.set(key, e);
    }
    return m;
  }, [elements]);

  function findElementForPrediction(r) {
    if (r.element != null && elementById.has(Number(r.element))) return elementById.get(Number(r.element));
    if (r.understat_id != null && elementByUnderstat.has(String(r.understat_id)))
      return elementByUnderstat.get(String(r.understat_id));
    if (r.fbref_id != null && elementByFbref.has(String(r.fbref_id))) return elementByFbref.get(String(r.fbref_id));
    const nm = String(r.matched_player_name || r.name || "").trim().toLowerCase();
    const tm = String(r.matched_team_name || r.canonical_team_name || r.team || "").trim().toLowerCase();
    if (nm && tm) {
      const key = `${nm}__${tm}`;
      if (elementByNameTeam.has(key)) return elementByNameTeam.get(key);
    }
    return null;
  }

  const positions = ["", "GK", "DEF", "MID", "FWD"];

  const teams = useMemo(() => {
    const s = new Set();
    predRows.forEach((r) =>
      (r.matched_team_name || r.canonical_team_name || r.team) &&
      s.add(normalizeTeamNameForLogo(r.matched_team_name || r.canonical_team_name || r.team))
    );
    return ["", ...Array.from(s).sort((a, b) => a.localeCompare(b))];
  }, [predRows]);

  const currentEvent = useMemo(() => {
    if (!events?.length) return null;
    return (
      events.find((e) => e.is_current) ||
      events.find((e) => e.is_next) ||
      [...events].reverse().find((e) => e.finished) ||
      events[0]
    );
  }, [events]);

  const mostCaptained = useMemo(() => {
    const id = currentEvent?.most_captained;
    return id != null ? elementById.get(Number(id)) : null;
  }, [currentEvent, elementById]);

  const mostSelectedOverall = useMemo(() => {
    if (!elements?.length) return null;
    return [...elements].sort(
      (a, b) => parseFloat(b.selected_by_percent || 0) - parseFloat(a.selected_by_percent || 0)
    )[0];
  }, [elements]);

  const highestForm = useMemo(() => {
    if (!elements?.length) return null;
    return [...elements].sort((a, b) => parseFloat(b.form || 0) - parseFloat(a.form || 0))[0];
  }, [elements]);

  const topPerformersGW = useMemo(() => {
    if (!elements?.length) return [];
    const arr = elements.filter((e) => num(e.event_points) > 0);
    return arr.sort((a, b) => num(b.event_points) - num(a.event_points)).slice(0, 8);
  }, [elements]);

  const mostInGW = useMemo(() => {
    if (!elements?.length) return [];
    return [...elements].sort((a, b) => num(b.transfers_in_event) - num(a.transfers_in_event)).slice(0, 8);
  }, [elements]);

  const mostOutGW = useMemo(() => {
    if (!elements?.length) return [];
    return [...elements].sort((a, b) => num(b.transfers_out_event) - num(a.transfers_out_event)).slice(0, 8);
  }, [elements]);

  // === Optimizer ===
  function buildBestSquad({
    predRows,
    elements,
    elementTypes,
    teamLimit = 3,
    budget = 100.0,
  }) {
    if (!Array.isArray(predRows) || !predRows.length || !Array.isArray(elements) || !elements.length) {
      return null;
    }

    const byId = new Map(elements.map(e => [Number(e.id), e]));
    const byUnderstat = new Map(elements.filter(e => e.understat_id != null).map(e => [String(e.understat_id), e]));
    const byFbref = new Map(elements.filter(e => e.fbref_id != null).map(e => [String(e.fbref_id), e]));

    const typeById = (() => {
      const m = new Map();
      for (const t of (elementTypes || [])) {
        const short =
          t.singular_name_short?.toUpperCase?.() ||
          t.short_singular_name?.toUpperCase?.() ||
          t.singular_name?.toUpperCase?.();
        let pos = short;
        if (short === "GKP" || short === "GK") pos = "GK";
        if (short === "DEF") pos = "DEF";
        if (short === "MID") pos = "MID";
        if (short === "FWD" || short === "FW") pos = "FWD";
        m.set(Number(t.id), pos);
      }
      return m;
    })();

    const quotas = {
      GK: elementTypes?.find(t => typeById.get(t.id) === "GK")?.squad_select ?? 2,
      DEF: elementTypes?.find(t => typeById.get(t.id) === "DEF")?.squad_select ?? 5,
      MID: elementTypes?.find(t => typeById.get(t.id) === "MID")?.squad_select ?? 5,
      FWD: elementTypes?.find(t => typeById.get(t.id) === "FWD")?.squad_select ?? 3,
    };

    function matchElement(r) {
      if (r.element != null && byId.has(Number(r.element))) return byId.get(Number(r.element));
      if (r.understat_id != null && byUnderstat.has(String(r.understat_id))) return byUnderstat.get(String(r.understat_id));
      if (r.fbref_id != null && byFbref.has(String(r.fbref_id))) return byFbref.get(String(r.fbref_id));
      const nm = String(r.matched_player_name || r.name || "").trim().toLowerCase();
      const tm = String(r.matched_team_name || r.canonical_team_name || r.team || "").trim().toLowerCase();
      if (!nm || !tm) return null;
      return elements.find(e =>
        String(e.player_name_normalized || e.web_name || `${e.first_name} ${e.second_name}`)
          .trim().toLowerCase() === nm &&
        String(e.canonical_team_name || e.team_norm || e.team_name || "")
          .trim().toLowerCase() === tm
      ) || null;
    }

    const candidates = [];
    for (const r of predRows) {
      const e = matchElement(r);
      if (!e) continue;
      const price = Number(e.now_cost) / 10;
      const pos = r.position || typeById.get(Number(e.element_type));
      if (!price || !pos || !["GK", "DEF", "MID", "FWD"].includes(pos)) continue;

      const points = Number(r.predicted_total_points) || 0;
      if (points <= 0) continue;

      candidates.push({
        key: String(r.understat_id ?? r.element ?? r.fbref_id ?? `${e.id}-${e.web_name}`),
        name: r.matched_player_name || r.name || e.web_name,
        teamName: normalizeTeamNameForLogo(
          pickTeamNameForLogo(
            r.canonical_team_name,
            r.matched_team_name,
            r.team
          )
        ),
        teamId: Number(e.team) || 0,
        elementId: Number(e.id) || null,
        ustatId: r.understat_id != null ? String(r.understat_id) : null,
        pos,
        price,
        points,
      });
    }
    if (!candidates.length) return null;

    const byPos = { GK: [], DEF: [], MID: [], FWD: [] };
    for (const c of candidates) {
      c.vpm = c.price > 0 ? c.points / c.price : 0;
      byPos[c.pos].push(c);
    }
    for (const k of Object.keys(byPos)) {
      byPos[k].sort((a, b) => b.vpm - a.vpm || b.points - a.points);
    }

    const cheapestSum = (arr, k) =>
      arr.slice().sort((a, b) => a.price - b.price).slice(0, k).reduce((s, x) => s + x.price, 0);

    const need = {
      GK: quotas.GK,
      DEF: quotas.DEF,
      MID: quotas.MID,
      FWD: quotas.FWD,
    };

    const teamCount = new Map();
    const selected = [];
    const order = ["GK", "FWD", "DEF", "MID"];

    function stillNeededCost(pos, nLeft, skipSet) {
      if (nLeft <= 0) return 0;
      const pool = byPos[pos].filter(x => !skipSet.has(x.key));
      return cheapestSum(pool, nLeft);
    }

    for (const pos of order) {
      const pool = byPos[pos];
      const must = need[pos];
      const used = new Set(selected.map(s => s.key));

      let taken = 0;
      for (const cand of pool) {
        if (taken >= must) break;
        if (used.has(cand.key)) continue;
        const tcnt = teamCount.get(cand.teamId) || 0;
        if (tcnt >= 3) continue; // FPL team limit

        const skip = new Set([...used, cand.key]);
        let remBudget = 100 - selected.reduce((s, x) => s + x.price, 0) - cand.price;

        let futureMin = 0;
        for (const p2 of order) {
          const left = (p2 === pos) ? (need[p2] - (taken + 1)) : (need[p2] - (p2 === pos ? taken : selected.filter(s => s.pos === p2).length));
          const l = Math.max(0, left);
          futureMin += stillNeededCost(p2, l, skip);
        }
        if (remBudget >= futureMin) {
          selected.push(cand);
          teamCount.set(cand.teamId, tcnt + 1);
          taken++;
        }
      }
    }

    function totals(arr) {
      return {
        cost: arr.reduce((s, x) => s + x.price, 0),
        points: arr.reduce((s, x) => s + x.points, 0),
      };
    }

    // Build best XI
    const gks  = selected.filter(x => x.pos === "GK").sort((a, b) => b.points - a.points);
    const defs = selected.filter(x => x.pos === "DEF").sort((a, b) => b.points - a.points);
    const mids = selected.filter(x => x.pos === "MID").sort((a, b) => b.points - a.points);
    const fwds = selected.filter(x => x.pos === "FWD").sort((a, b) => b.points - a.points);

    const combos = [];
    for (let d = 3; d <= 5; d++) {
      for (let m = 3; m <= 5; m++) {
        for (let f = 1; f <= 3; f++) {
          if (d + m + f === 10) combos.push({ d, m, f });
        }
      }
    }
    let bestXI = null;
    for (const c of combos) {
      if (defs.length < c.d || mids.length < c.m || fwds.length < c.f || gks.length < 1) continue;
      const xi = [gks[0], ...defs.slice(0, c.d), ...mids.slice(0, c.m), ...fwds.slice(0, c.f)];
      const pts = xi.reduce((s, x) => s + x.points, 0);
      if (!bestXI || pts > bestXI.points) bestXI = { d: c.d, m: c.m, f: c.f, xi, points: pts };
    }

    const xiKeys = new Set((bestXI?.xi || []).map(p => p.key));
    const benchPool = selected.filter(p => !xiKeys.has(p.key));
    const bench = benchPool.sort((a, b) => a.pos === "GK" ? -1 : (a.points - b.points)).slice(0, 4);

    return {
      selected: selected.sort((a, b) => {
        const ord = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
        if (a.pos !== b.pos) return ord[a.pos] - ord[b.pos];
        return b.points - a.points;
      }),
      totals: totals(selected),
      bestXI,
      bench,
      quotas,
    };
  }

  const bestSquad = useMemo(() => {
    if (!boot || !predRows?.length) return null;
    return buildBestSquad({
      predRows,
      elements: boot.elements || [],
      elementTypes: boot.element_types || [],
      teamLimit: 3,
      budget: 100.0,
    });
  }, [boot, predRows]);

  // filters for table
  const filtered = useMemo(() => {
    const qlc = q.trim().toLowerCase();
    const pickTeam = team.trim();
    const pickPos = pos.trim();
    return predRows
      .filter((r) => (qlc ? (String(r.matched_player_name || r.name || "").toLowerCase().includes(qlc)) : true))
      .filter((r) => {
        if (!pickTeam) return true;
        const t = normalizeTeamNameForLogo(r.matched_team_name || r.canonical_team_name || r.team);
        return t === pickTeam;
      })
      .filter((r) => (pickPos ? r.position === pickPos : true))
      .sort((a, b) => num(b.predicted_total_points) - num(a.predicted_total_points))
      .slice(0, Math.max(1, limit));
  }, [predRows, q, team, pos, limit]);

  /* ============================== UI Bits ============================== */

  function MiniStat({ label, value, sub, tone = "slate" }) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-1 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{label}</div>
        <div className="flex items-center gap-2">
          <div className="text-base font-semibold">{value}</div>
          {sub ? <Badge tone={tone}>{sub}</Badge> : null}
        </div>
      </div>
    );
  }

  function PlayerCard({ p }) {
    const vpm = p.price ? (p.points / p.price) : 0;
    return (
      <button
        type="button"
        onClick={() => openPlayerNormalized(p.teamName, String(p.ustatId ?? p.elementId ?? p.key))}
        className="group relative w-28 sm:w-36 rounded-xl border border-white/30 bg-white/10 p-2 text-left shadow-md backdrop-blur transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:border-white/20"
        title={`${p.name} (${p.pos})`}
      >
        <div className="absolute -top-2 -left-2 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white">
          {p.pos}
        </div>
        <div className="flex items-center gap-2">
          <img
            src={logoUrl(p.teamName)}
            alt=""
            className="h-6 w-6 rounded bg-white object-contain ring-1 ring-white/50"
            onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-white drop-shadow">{p.name}</div>
            <div className="truncate text-[11px] text-white/80">{p.teamName}</div>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-white/90">
          <span className="tabular-nums">£{p.price.toFixed(1)}</span>
          <span className="tabular-nums font-semibold">{p.points.toFixed(1)} pts</span>
        </div>
        <div className="mt-1 text-[10px] text-white/80">VPM <span className="tabular-nums">{vpm.toFixed(2)}</span></div>
      </button>
    );
  }

  function BenchCard({ p }) {
    return (
      <button
        type="button"
        onClick={() => openPlayerNormalized(p.teamName, String(p.ustatId ?? p.elementId ?? p.key))}
        className="group flex min-w-[11rem] sm:min-w-[12rem] items-center gap-2 rounded-xl border border-zinc-200 bg-white px-2 py-1.5 text-left shadow-sm hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
        title={`${p.name} (${p.pos})`}
      >
        <img
          src={logoUrl(p.teamName)}
          alt=""
          className="h-6 w-6 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
          onError={(ev) => (ev.currentTarget.src = "/logos/_default.png")}
        />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{p.name}</div>
          <div className="truncate text-[11px] text-zinc-500">{p.teamName}</div>
        </div>
        <div className="ml-auto text-right text-[11px]">
          <div className="tabular-nums font-semibold">{p.points.toFixed(1)} pts</div>
          <div className="tabular-nums text-zinc-500">£{p.price.toFixed(1)}</div>
        </div>
      </button>
    );
  }

  function FormationRows({ bestXI }) {
    if (!bestXI) return null;
    const xi   = bestXI.xi || [];
    const gks  = xi.filter((p) => p.pos === "GK");
    const defs = xi.filter((p) => p.pos === "DEF");
    const mids = xi.filter((p) => p.pos === "MID");
    const fwds = xi.filter((p) => p.pos === "FWD");

    return (
      <div className="relative isolate w-full overflow-hidden rounded-2xl">
        {/* pitch bg */}
        <div className="absolute inset-0">
          <div className="absolute inset-0" style={{ background: "linear-gradient(0deg,#0c6a51,#0a5a43)" }} />
          <div className="absolute inset-0 opacity-30"
               style={{background:"repeating-linear-gradient(0deg, transparent 0 38px, rgba(255,255,255,.08) 38px 76px)"}}/>
          <div className="absolute inset-2 rounded-2xl border-2 border-white/40" />
          <div className="absolute left-1/2 top-1/2 h-28 w-28 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/30" />
          <div className="absolute left-1/2 top-2 h-28 w-[86%] -translate-x-1/2 rounded-b-[24px] border-2 border-white/35" />
          <div className="absolute bottom-2 left-1/2 h-28 w-[86%] -translate-x-1/2 rounded-t-[24px] border-2 border-white/35" />
          <div className="absolute left-1/2 top-2 h-16 w-[46%] -translate-x-1/2 rounded-b-[18px] border-2 border-white/35" />
          <div className="absolute bottom-2 left-1/2 h-16 w-[46%] -translate-x-1/2 rounded-t-[18px] border-2 border-white/35" />
        </div>

        {/* players */}
        <div className="relative z-10 flex w-full flex-col gap-4 px-2 py-4 sm:px-3 sm:py-6">
          <div className="flex flex-wrap items-start justify-center gap-2 sm:gap-4">
            {gks.map((p) => <PlayerCard key={p.key} p={p} />)}
          </div>
          <div className="flex flex-wrap items-start justify-center gap-2 sm:gap-4">
            {defs.map((p) => <PlayerCard key={p.key} p={p} />)}
          </div>
          <div className="flex flex-wrap items-start justify-center gap-2 sm:gap-4">
            {mids.map((p) => <PlayerCard key={p.key} p={p} />)}
          </div>
          <div className="flex flex-wrap items-start justify-center gap-2 sm:gap-4">
            {fwds.map((p) => <PlayerCard key={p.key} p={p} />)}
          </div>
        </div>
      </div>
    );
  }

  function BestSquadCard({ best }) {
    if (!best) return null;
    const { totals, bestXI, bench } = best;
    return (
      <div className="mb-6 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold">Suggested Best Squad (15)</div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-700 dark:text-zinc-400">
            <Badge tone="green">
              Best XI {bestXI ? `${bestXI.points.toFixed(1)} pts` : "—"}
            </Badge>
            {bestXI && <Badge tone="indigo">{bestXI.d}-{bestXI.m}-{bestXI.f}</Badge>}
            <Badge tone="zinc">Squad {totals.points.toFixed(1)} pts</Badge>
            <Badge tone="amber">£{totals.cost.toFixed(1)}</Badge>
          </div>
        </div>

        <FormationRows bestXI={bestXI} />

        <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900/30">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">Bench (4)</div>
            <div className="text-[11px] text-zinc-600 dark:text-zinc-400">
              GK2 + 3 outfield (sorted by priority)
            </div>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {bench.map((p) => (
              <BenchCard key={p.key} p={p} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  /* ============================== Render ============================== */

  return (
    <section id="predictions" className="mx-auto w-full max-w-6xl px-2 pt-6 md:px-0">
      <div className="mb-3 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Fantasy Premier League</h1>
        </div>
      </div>

      {/* Quick GW bar */}
      <div className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-1 flex items-center justify-between">
            <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">Gameweek</div>
            {!!currentEvent && (
              <Badge tone={currentEvent.finished ? "green" : currentEvent.is_next ? "indigo" : "amber"}>
                {currentEvent.finished ? "Finished" : currentEvent.is_next ? "Next" : "In progress"}
              </Badge>
            )}
          </div>
          <div className="text-base font-semibold">
            {currentEvent ? currentEvent.name : "—"}
          </div>
          <div className="mt-1 text-[12px] text-zinc-600 dark:text-zinc-300">
            Avg: <span className="tabular-nums font-semibold">
              {currentEvent?.average_entry_score ?? "—"}
            </span>
          </div>
          <div className="mt-1 text-[12px] text-zinc-600 dark:text-zinc-300">
            Highest: <span className="tabular-nums font-semibold">
              {currentEvent?.highest_score ?? "—"}
            </span>
          </div>
        </div>

        <MiniStat
          label="Most Captained (GW)"
          value={mostCaptained ? `${mostCaptained.web_name} ` : "—"}
          sub={mostCaptained?.canonical_team_name || mostCaptained?.team_norm}
          tone="indigo"
        />

        <MiniStat
          label="Highest Form (season)"
          value={highestForm ? `${highestForm.web_name}` : "—"}
          sub={highestForm ? `Form ${round1(parseFloat(highestForm.form || 0))}` : ""}
          tone="violet"
        />

        <MiniStat
          label="Most Selected (season)"
          value={mostSelectedOverall ? `${mostSelectedOverall.web_name}` : "—"}
          sub={mostSelectedOverall ? `${round1(parseFloat(mostSelectedOverall.selected_by_percent || 0))}%` : ""}
          tone="green"
        />
      </div>

      {/* Lists */}
      <div className="mb-5 grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* Top performers (GW) */}
        <div className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-2 text-sm font-semibold">Top performers (GW)</div>
          {bootLoading ? (
            <div className="text-sm text-zinc-500">Loading…</div>
          ) : topPerformersGW.length ? (
            <ol className="space-y-1.5">
              {topPerformersGW.map((e) => (
                <li key={`tp-${e.id}`}>
                  <button
                    type="button"
                    onClick={() => openPlayerNormalized(
                      e.canonical_team_name || e.team_norm || e.team,
                      String(e.understat_id ?? e.id)
                    )}
                    className="group flex w-full items-center justify-between gap-2 rounded-md border border-transparent px-2 py-1.5 text-left hover:border-zinc-300 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:hover:bg-zinc-900"
                    title="Open player"
                  >
                    <div className="flex items-center gap-2">
                      <img
                        src={logoUrl(pickTeamNameForLogo(e.canonical_team_name, e.team_norm, e.team))}
                        alt=""
                        className="h-5 w-5 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
                        onError={(ev) => (ev.currentTarget.src = "/logos/_default.png")}
                      />
                      <div className="leading-tight">
                        <div className="text-sm font-medium group-hover:underline">{e.web_name}</div>
                        <div className="text-[11px] text-zinc-500">{e.canonical_team_name || e.team_norm}</div>
                      </div>
                    </div>
                    <div className="text-sm font-semibold tabular-nums">{e.event_points}</div>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <div className="text-sm text-zinc-500">No GW points yet.</div>
          )}
        </div>

        {/* Most transferred in (GW) */}
        <div className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-2 text-sm font-semibold">Most transferred in (GW)</div>
          {bootLoading ? (
            <div className="text-sm text-zinc-500">Loading…</div>
          ) : mostInGW.length ? (
            <ol className="space-y-1.5">
              {mostInGW.map((e) => (
                <li key={`in-${e.id}`}>
                  <button
                    type="button"
                    onClick={() =>
                      openPlayerNormalized(
                        e.canonical_team_name || e.team_norm || e.team,
                        String(e.understat_id ?? e.id)
                      )
                    }
                    className="group flex w-full items-center justify-between gap-2 rounded-md border border-transparent px-2 py-1.5 text-left hover:border-zinc-300 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:hover:bg-zinc-900"
                    title="Open player"
                  >
                    <div className="flex items-center gap-2">
                      <img
                        src={logoUrl(pickTeamNameForLogo(e.canonical_team_name, e.team_norm, e.team))}
                        alt=""
                        className="h-5 w-5 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
                        onError={(ev) => (ev.currentTarget.src = "/logos/_default.png")}
                      />
                      <div className="leading-tight">
                        <div className="text-sm font-medium group-hover:underline">{e.web_name}</div>
                        <div className="text-[11px] text-zinc-500">
                          {e.canonical_team_name || e.team_norm}
                        </div>
                      </div>
                    </div>
                    <div className="text-sm font-semibold tabular-nums">
                      {e.transfers_in_event?.toLocaleString?.() ?? e.transfers_in_event}
                    </div>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <div className="text-sm text-zinc-500">No transfers yet.</div>
          )}
        </div>

        {/* Most transferred out (GW) */}
        <div className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mb-2 text-sm font-semibold">Most transferred out (GW)</div>
          {bootLoading ? (
            <div className="text-sm text-zinc-500">Loading…</div>
          ) : mostOutGW.length ? (
            <ol className="space-y-1.5">
              {mostOutGW.map((e) => (
                <li key={`out-${e.id}`}>
                  <button
                    type="button"
                    onClick={() =>
                      openPlayerNormalized(
                        e.canonical_team_name || e.team_norm || e.team,
                        String(e.understat_id ?? e.id)
                      )
                    }
                    className="group flex w-full items-center justify-between gap-2 rounded-md border border-transparent px-2 py-1.5 text-left hover:border-zinc-300 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:hover:bg-zinc-900"
                    title="Open player"
                  >
                    <div className="flex items-center gap-2">
                      <img
                        src={logoUrl(pickTeamNameForLogo(e.canonical_team_name, e.team_norm, e.team))}
                        alt=""
                        className="h-5 w-5 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
                        onError={(ev) => (ev.currentTarget.src = "/logos/_default.png")}
                      />
                      <div className="leading-tight">
                        <div className="text-sm font-medium group-hover:underline">{e.web_name}</div>
                        <div className="text-[11px] text-zinc-500">
                          {e.canonical_team_name || e.team_norm}
                        </div>
                      </div>
                    </div>
                    <div className="text-sm font-semibold tabular-nums">
                      {e.transfers_out_event?.toLocaleString?.() ?? e.transfers_out_event}
                    </div>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <div className="text-sm text-zinc-500">No transfers yet.</div>
          )}
        </div>
      </div>

      {/* Predicted points header */}
      <div className="mb-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Predicted points — Next Gameweek
        </h2>
        <p className="mt-1 text-sm text-zinc-600 font-medium dark:text-zinc-300">
          Trained on 150,000+ rows with 30+ engineered features (fixture difficulty, rolling form, xG/xA, minutes expectation, bonus potential).
        </p>
      </div>

      {/* Model picker */}
      <div className="mt-3 mb-5 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex-1">
            <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              Choose model
            </label>
            <select
              className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-3 text-base shadow-sm outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-zinc-700 dark:bg-zinc-900"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              title="Select prediction model"
            >
              {MODEL_OPTIONS.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="md:w-1/2">
            <div className="text-sm text-zinc-700 dark:text-zinc-500">
              {MODEL_DESC[model] || "Model description unavailable."}
            </div>
            {modelMae != null && (
              <div className="mt-1 text[16px] font-bold text-zinc-700 dark:text-zinc-500">
                Validation MAE:&nbsp;
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-200">
                  {Number(modelMae).toFixed(4)}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      <BestSquadCard best={bestSquad} />

      {/* Filters */}
      <div className="sticky top-[56px] z-10 mb-3 rounded-xl border border-zinc-200 bg-white/85 p-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-6">
          <input
            placeholder="Search player…"
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-zinc-700 dark:bg-zinc-900"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-zinc-700 dark:bg-zinc-900"
            value={team}
            onChange={(e) => setTeam(e.target.value)}
          >
            {teams.map((t) => (
              <option key={t || "_any"} value={t}>
                {t || "All teams"}
              </option>
            ))}
          </select>
          <select
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-zinc-700 dark:bg-zinc-900"
            value={pos}
            onChange={(e) => setPos(e.target.value)}
          >
            {positions.map((p) => (
              <option key={p || "_any"} value={p}>
                {p || "All positions"}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            <label className="text-sm text-zinc-600 dark:text-zinc-300">Top</label>
            <input
              type="number"
              min={10}
              max={1000}
              step={10}
              className="w-28 rounded-lg border border-zinc-300 bg-white px-2 py-2 text-sm shadow-sm outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-zinc-700 dark:bg-zinc-900"
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Number(e.target.value) || 100))}
            />
            <span className="text-sm text-zinc-500">players</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              onClick={() => {
                setPos("");
                setTeam("");
                setQ("");
                setLimit(100);
              }}
            >
              Reset
            </button>
          </div>
        </div>
      </div>

      {/* Predictions List (responsive) */}
      {predLoading ? (
        <div className="p-4 text-sm text-zinc-600 dark:text-zinc-300">Loading predictions…</div>
      ) : predErr ? (
        <div className="p-4 text-sm text-rose-600">Failed to load: {predErr}</div>
      ) : filtered.length === 0 ? (
        <div className="p-4 text-sm text-zinc-500">No results match your filters.</div>
      ) : (
        <>
          {/* Mobile: compact cards (no horizontal scroll) */}
          <div className="space-y-2 md:hidden">
            {filtered.map((r, i) => (
              <MobilePredictionCard
                key={`${r.understat_id || r.element || r.fbref_id || i}`}
                r={r}
                findElementForPrediction={findElementForPrediction}
                openPlayerNormalized={openPlayerNormalized}
                logoUrl={logoUrl}
                pickTeamNameForLogo={pickTeamNameForLogo}
                normalizeTeamNameForLogo={normalizeTeamNameForLogo}
                diffCardBg={diffCardBg}
                venuePillClass={venuePillClass}
                round1={round1}
                num={num}
              />
            ))}
          </div>

          {/* Desktop/Tablet: keep the full table */}
          <div className="hidden md:block overflow-auto rounded-xl border border-zinc-200 shadow-sm dark:border-zinc-800">
            <table className="min-w-full border-separate border-spacing-0 text-left text-sm">
              <thead className="bg-zinc-50 text-xs uppercase tracking-wide dark:bg-zinc-900">
                <tr>
                  <th className="px-3 py-2">Player</th>
                  <th className="px-3 py-2">Team</th>
                  <th className="px-3 py-2">Price</th>
                  <th className="px-3 py-2">Pos</th>
                  <th className="px-3 py-2">GW</th>
                  <th className="px-3 py-2">Opponent</th>
                  <th className="px-3 py-2">Projected</th>
                  <th className="px-3 py-2">Factors</th>
                  <th className="px-3 py-2">Details</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => {
                  const playerName = r.matched_player_name || r.name || "Unknown";
                  const teamName = normalizeTeamNameForLogo(
                    pickTeamNameForLogo(
                      r.matched_team_name || r.canonical_team_name,
                      r.matched_team_from_catalog,
                      r.team
                    )
                  );
                  const oppName = r.canonical_opponent_name || "";
                  const diff = r.next_opponent_difficulty ?? null;
                  const ex = String(r.explanation || "");
                  const venue = /away/i.test(ex) ? "AWAY" : /home/i.test(ex) ? "HOME" : null;
                  const pts = num(r.predicted_total_points);
                  const factorChips = (r.top_factors ? String(r.top_factors).split(";").map(s => s.trim()).filter(Boolean) : []).slice(0, 8);
                  const el = findElementForPrediction(r);
                  const price = el ? (num(el.now_cost) / 10).toFixed(1) : null;
                  const owner = el ? parseFloat(el.selected_by_percent || 0) : null;

                  return (
                    <tr
                      key={`${r.understat_id || r.element || r.fbref_id || i}`}
                      className="border-t border-zinc-200 align-top odd:bg-zinc-50/60 dark:border-zinc-800 dark:odd:bg-zinc-900/30"
                    >
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <img
                            src={logoUrl(teamName)}
                            alt=""
                            className="h-6 w-6 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
                            onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
                          />
                          <button
                            type="button"
                            className="font-medium hover:underline"
                            title="Open player profile"
                            onClick={() => {
                              const id = r.understat_id ?? r.element ?? r.fbref_id;
                              if (id != null) openPlayerNormalized(teamName, String(id));
                            }}
                          >
                            {playerName}
                          </button>
                        </div>
                        {owner != null && (
                          <div className="mt-1 text-[11px] text-zinc-500">
                            Selected by <span className="tabular-nums">{owner.toFixed(1)}%</span>
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200">
                          {teamName || "—"}
                        </span>
                      </td>
                      <td className="px-3 py-3">{price ? <span className="tabular-nums font-medium">£{price}</span> : "—"}</td>
                      <td className="px-3 py-3">{r.position || "—"}</td>
                      <td className="px-3 py-3">{r.next_gameweek ?? "—"}</td>
                      <td className="px-3 py-3">
                        <div className={`relative h-24 w-24 rounded-xl p-2 text-center ${diffCardBg(diff)}`}>
                          {venue && (
                            <span className={`absolute top-1 right-1 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ring-1 ring-white/30 ${venuePillClass(venue)}`}>
                              {venue === "HOME" ? "H" : "A"}
                            </span>
                          )}
                          <img
                            src={logoUrl(pickTeamNameForLogo(oppName, null, teamName))}
                            alt=""
                            className="mx-auto h-8 w-8 rounded bg-white object-contain ring-1 ring-white/50"
                            onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
                          />
                          <div className="mt-1 line-clamp-2 text-[11px] font-medium">
                            {oppName || "—"}
                          </div>
                          {diff != null && <div className="mt-1 text-[11px] font-semibold">★{diff}</div>}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="inline-flex items-center rounded-lg border border-zinc-300 px-2 py-1 text-sm font-semibold tabular-nums dark:border-zinc-700">
                          {round1(pts)} pts
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex max-w-[26rem] flex-wrap gap-1.5">
                          {factorChips.length ? (
                            factorChips.map((c, j) => (
                              <span key={j} className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">
                                {c}
                              </span>
                            ))
                          ) : (
                            <span className="text-zinc-400 text-xs">No factor breakdown.</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <details>
                          <summary className="cursor-pointer text-indigo-600 hover:underline dark:text-indigo-400">
                            View
                          </summary>
                          <div className="mt-2 space-y-2">
                            {r.explanation && (
                              <div className="max-w-xl text-xs leading-snug text-zinc-700 dark:text-zinc-300">
                                {r.explanation}
                              </div>
                            )}
                          </div>
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}


      {/* errors for bootstrap */}
      {bootErr && (
        <div className="mt-2 text-sm text-amber-600">
          FPL bootstrap failed to load: {bootErr}
        </div>
      )}
    </section>
  );
}

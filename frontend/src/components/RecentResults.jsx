import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

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
// API "YYYY-MM-DD HH:mm:ss" -> local Date (treat as UTC)
function parseUtcToLocal(utcStr) {
  const iso = utcStr.replace(" ", "T") + "Z";
  return new Date(iso);
}
function fmtDate(dt) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit" }).format(dt);
}
function fmtTime(dt) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(dt);
}

/**
 * RecentResults — horizontally scrolling cards with snap + auto-advance
 * Props:
 *  - apiBase: string
 *  - onOpenMatch: (matchId: string) => void
 *  - onShowAll: () => void
 *  - autoAdvanceMs?: number (optional; default 2600)
 *  - limit?: number (optional; default 20)
 */
export default function RecentResults({
  apiBase,
  onOpenMatch,
  onShowAll,
  autoAdvanceMs = 2600,
  limit = 20,
}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const viewportRef = useRef(null);
  const firstCardRef = useRef(null);
  const timerRef = useRef(null);
  const indexRef = useRef(0);     // current snap index within original list
  const cardStepRef = useRef(0);  // measured (card width + gap)

  useEffect(() => {
    if (!apiBase) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        setLoading(true);
        setErr(null);
        const data = await fetchJson(`${apiBase}/recents`, { signal: ctrl.signal });
        const list = Array.isArray(data) ? data : [];
        const mapped = list
          .map((m) => {
            const dt = parseUtcToLocal(m.datetime);
            return {
              id: String(m.id),
              date: dt,
              home: m.home_team,
              away: m.away_team,
              home_goals: Number(m.home_goals ?? 0),
              away_goals: Number(m.away_goals ?? 0),
              venue: m.venue || "",
            };
          })
          .sort((a, b) => b.date - a.date)
          .slice(0, limit);
        setRows(mapped);
      } catch (e) {
        if (e.name !== "AbortError") setErr(String(e));
      } finally {
        setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [apiBase, limit]);

  // Build doubled list for seamless loop
  const doubled = useMemo(() => [...rows, ...rows], [rows]);

  // Measure card width + container gap to get a snap step
  useEffect(() => {
    const cont = viewportRef.current;
    const card = firstCardRef.current;
    if (!cont || !card || rows.length === 0) return;

    const measure = () => {
      const rect = card.getBoundingClientRect();
      const styles = getComputedStyle(cont);
      const gapPx = parseFloat(styles.columnGap || styles.gap || "0") || 0;
      cardStepRef.current = rect.width + gapPx;
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(card);
    ro.observe(cont);
    return () => ro.disconnect();
  }, [rows.length]);

  // Keep indexRef aligned with manual drag/scroll
  useEffect(() => {
    const cont = viewportRef.current;
    if (!cont) return;

    const onScroll = () => {
      const step = cardStepRef.current || 1;
      if (step <= 0 || rows.length === 0) return;
      // Round to nearest card index within doubled list, then mod original length
      const idx = Math.round(cont.scrollLeft / step);
      indexRef.current = idx % (rows.length || 1);
    };
    cont.addEventListener("scroll", onScroll, { passive: true });
    return () => cont.removeEventListener("scroll", onScroll);
  }, [rows.length]);

  // Auto-advance with seamless snap loop & pause on hover
  useEffect(() => {
    const cont = viewportRef.current;
    const n = rows.length;
    if (!cont || n === 0) return;

    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const stop = () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    const start = () => {
      if (prefersReduced) return; // no auto-scroll if user prefers reduced motion
      stop();
      timerRef.current = setInterval(() => {
        const step = cardStepRef.current || 0;
        if (step <= 0) return;

        const next = indexRef.current + 1;

        cont.scrollTo({ left: (indexRef.current + 1) * step, behavior: "smooth" });
        indexRef.current = (indexRef.current + 1) % (n * 2);

        // Crossing original -> clone boundary (index == n)
        if (next === n) {
          setTimeout(() => {
            const hadSmooth = cont.classList.contains("scroll-smooth");
            cont.classList.remove("scroll-smooth");
            cont.scrollLeft -= n * step; // instant jump back by n cards
            // force reflow
            // eslint-disable-next-line no-unused-expressions
            cont.offsetHeight;
            if (hadSmooth) cont.classList.add("scroll-smooth");
            indexRef.current = indexRef.current - n;
            if (indexRef.current < 0) indexRef.current += n * 2;
          }, 380);
        }
      }, autoAdvanceMs);
    };

    const onEnter = () => stop();
    const onLeave = () => start();

    cont.addEventListener("mouseenter", onEnter);
    cont.addEventListener("mouseleave", onLeave);

    // init
    cont.scrollTo({ left: 0, behavior: "auto" });
    start();

    return () => {
      stop();
      cont.removeEventListener("mouseenter", onEnter);
      cont.removeEventListener("mouseleave", onLeave);
    };
  }, [rows.length, autoAdvanceMs]);

  const handleStep = (dir = 1) => {
    const el = viewportRef.current;
    if (!el) return;
    const step = cardStepRef.current || ((el.querySelector("[data-card]")?.clientWidth || 320) + 12);
    el.scrollBy({ left: dir * step, behavior: "smooth" });
  };

  return (
    <section className="mx-auto w-full max-w-6xl px-4 md:px-6">
      {/* Hide scrollbar across browsers (scoped) */}
      <style>{`
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
      `}</style>

      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Recent Results</h2>
        <button
          onClick={onShowAll}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          title="View all played matches"
        >
          View all results
        </button>
      </div>

      {loading && <p className="text-sm text-zinc-500">Loading…</p>}
      {err && <p className="text-sm text-rose-600">Failed to load results.</p>}
      {!loading && !err && rows.length === 0 && (
        <p className="text-sm text-zinc-500">No results yet.</p>
      )}

      {/* Scroll-snap carousel (consistent with RollingFixtures) */}
      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-1">
          <button
            onClick={() => handleStep(-1)}
            className="pointer-events-auto inline-flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 bg-white shadow-sm hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
            aria-label="Previous"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </div>
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-1">
          <button
            onClick={() => handleStep(1)}
            className="pointer-events-auto inline-flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 bg-white shadow-sm hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
            aria-label="Next"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div
          ref={viewportRef}
          className="no-scrollbar flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth rounded-2xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950"
        >
          {doubled.map((m, i) => (
            <ResultCard
              key={`${m.id}-${i}`}
              m={m}
              onClick={() => onOpenMatch?.(m.id)}
              firstRef={i === 0 ? firstCardRef : null}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function ResultCard({ m, onClick, firstRef }) {
  const homeWon = m.home_goals > m.away_goals;
  const awayWon = m.away_goals > m.home_goals;

  return (
    <button
      data-card
      ref={firstRef || null}
      onClick={onClick}
      className="snap-start inline-flex w-[22rem] shrink-0 flex-col gap-2 rounded-2xl border border-zinc-200 bg-white p-3 text-left shadow-sm transition hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950"
      title="Open match center"
    >
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <div className="tabular-nums">{fmtDate(m.date)} • {fmtTime(m.date)}</div>
        {m.venue && <div className="truncate">{m.venue}</div>}
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <img
            src={logoUrl(m.home)}
            alt=""
            className="h-6 w-6 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
            onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
          />
          <div className={`truncate text-sm ${homeWon ? "font-semibold text-emerald-600 dark:text-emerald-400" : "text-zinc-800 dark:text-zinc-200"}`}>
            {m.home}
          </div>
        </div>

        <div className="shrink-0 tabular-nums text-lg font-extrabold">
          {m.home_goals} — {m.away_goals}
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <img
            src={logoUrl(m.away)}
            alt=""
            className="h-6 w-6 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
            onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
          />
          <div className={`truncate text-sm ${awayWon ? "font-semibold text-emerald-600 dark:text-emerald-400" : "text-zinc-800 dark:text-zinc-200"}`}>
            {m.away}
          </div>
        </div>
      </div>
    </button>
  );
}

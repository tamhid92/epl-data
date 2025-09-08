import React, { useEffect, useMemo, useRef, useState } from "react";

/** Parse "YYYY-MM-DD HH:mm:ss" as UTC -> local Date */
function parseUtcToLocal(utcStr) {
  const iso = utcStr.replace(" ", "T") + "Z";
  return new Date(iso);
}
function fmtDate(dt) {
  return new Intl.DateTimeFormat(undefined, {
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
 * RollingFixtures — snap card scroller (no internal header/border)
 * Props:
 *  - endpoint (string): e.g. `${API_BASE}/fixtures/upcoming`
 *  - limit (number)    : default 10
 *  - autoAdvanceMs     : default 2800
 */
export default function RollingFixtures({
  endpoint,
  limit = 10,
  autoAdvanceMs = 2800,
}) {
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState("idle");

  const containerRef = useRef(null);
  const cardRef = useRef(null);
  const timerRef = useRef(null);
  const indexRef = useRef(0);     // current snap index (within original list)
  const cardStepRef = useRef(0);  // measured step in px (card width + gap)

  // Fetch fixtures
  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        setStatus("loading");
        const res = await fetch(endpoint, {
          signal: ctrl.signal,
          headers: {"X-API-TOKEN": import.meta.env.VITE_API_TOKEN },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setRows(Array.isArray(data) ? data : []);
        setStatus("idle");
      } catch (e) {
        console.error("fixtures load failed:", e);
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
     };
  }, [endpoint]);

  // Map + limit
  const fixtures = useMemo(() => {
    return rows.slice(0, limit).map((f) => {
      const when = parseUtcToLocal(f.datetime);
      return {
        id: String(f.id),
        home: f.home_team,
        away: f.away_team,
        date: fmtDate(when),
        time: fmtTime(when),
        venue: f.venue || "",
      };
    });
  }, [rows, limit]);

  // Duplicate list for seamless loop
  const doubled = useMemo(() => [...fixtures, ...fixtures], [fixtures]);

  // Measure a card + gap to compute snap step
  useEffect(() => {
    const cont = containerRef.current;
    const card = cardRef.current;
    if (!cont || !card || fixtures.length === 0) return;

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
  }, [fixtures.length]);

  // Keep index in sync when user scrolls manually
  useEffect(() => {
    const cont = containerRef.current;
    if (!cont) return;

    const onScroll = () => {
      const step = cardStepRef.current || 1;
      indexRef.current = Math.round(cont.scrollLeft / step) % (fixtures.length || 1);
    };
    cont.addEventListener("scroll", onScroll, { passive: true });
    return () => cont.removeEventListener("scroll", onScroll);
  }, [fixtures.length]);

  // Auto-advance with seamless snap; pauses on hover; respects reduced motion
  useEffect(() => {
    const cont = containerRef.current;
    const n = fixtures.length;
    if (!cont || n === 0) return;

    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (prefersReduced) return;

    const stop = () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    const start = () => {
      stop();
      timerRef.current = setInterval(() => {
        const step = cardStepRef.current || 0;
        if (step <= 0) return;

        const next = indexRef.current + 1;

        cont.scrollTo({ left: (indexRef.current + 1) * step, behavior: "smooth" });
        indexRef.current = (indexRef.current + 1) % (n * 2);

        // If we crossed the clone boundary, jump back instantly by n cards
        if (next === n) {
          setTimeout(() => {
            const hadSmooth = cont.classList.contains("scroll-smooth");
            cont.classList.remove("scroll-smooth");
            cont.scrollLeft -= n * step;
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

    cont.scrollTo({ left: 0, behavior: "auto" });
    start();

    return () => {
      stop();
      cont.removeEventListener("mouseenter", onEnter);
      cont.removeEventListener("mouseleave", onLeave);
    };
  }, [fixtures.length, autoAdvanceMs]);

  if (status === "error") {
    return <p className="text-sm text-rose-600">Failed to load fixtures.</p>;
  }

  // Hide native scrollbars on WebKit
  const hideScrollbar = `
    .rf-no-scrollbar::-webkit-scrollbar{ display:none; }
    .rf-no-scrollbar{ -ms-overflow-style:none; scrollbar-width:none; }
  `;

  return (
    <div className="w-full">
      <style>{hideScrollbar}</style>
      <div
        ref={containerRef}
        className="rf-no-scrollbar flex snap-x snap-mandatory overflow-x-auto scroll-smooth gap-3"
      >
        {doubled.map((fx, i) => (
          <FixtureCard
            key={`${fx.id}-${i}`}
            ref={i === 0 ? cardRef : null}
            fx={fx}
          />
        ))}
      </div>
    </div>
  );
}

const FixtureCard = React.forwardRef(function FixtureCard({ fx }, ref) {
  return (
    <article
      ref={ref}
      className="snap-start my-1 mr-1 w-56 shrink-0 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-left shadow-sm transition hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950 sm:w-64 md:w-72"
    >
      {/* date/time row (matches RecentResults card heading style) */}
      <div className="mb-1 min-w-[92px] text-xs text-zinc-500">
        {fx.date} • <span className="tabular-nums">{fx.time}</span>
      </div>

      {/* home */}
      <div className="flex items-center gap-2">
        <img
          src={logoUrl(fx.home)}
          alt=""
          className="h-5 w-5 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
          loading="lazy"
          onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
        />
        <span className="font-medium">{fx.home}</span>
      </div>

      {/* vs separator */}
      <div className="my-1 text-center text-[11px] uppercase tracking-wide text-zinc-500">
        vs
      </div>

      {/* away */}
      <div className="flex items-center gap-2">
        <img
          src={logoUrl(fx.away)}
          alt=""
          className="h-5 w-5 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
          loading="lazy"
          onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
        />
        <span>{fx.away}</span>
      </div>

      {fx.venue && (
        <div className="mt-2 text-xs text-zinc-500">{fx.venue}</div>
      )}
    </article>
  );
});

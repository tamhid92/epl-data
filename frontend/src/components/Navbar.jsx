import React, { useEffect, useRef, useState, useMemo } from "react";
import {
  Menu,
  BarChart3,
  Users2,
  Trophy,
  Search,
  CalendarDays,
  User,
  LineChart,
  Sun,
  Moon,
  TrendingUp, // ✅ NEW
} from "lucide-react";
import { motion } from "framer-motion";

// Simple logo helper
function logoUrl(team) {
  return `/logos/${encodeURIComponent(team)}.png`;
}

/**
 * Props:
 *  - brand?: string
 *  - items?: [{label, href?, icon?}]
 *  - teams?: string[]
 *  - onItemClick?(item)
 *  - onOpenTeam?(teamName)
 *  - onOpenResults?()        
 *  - onOpenFixtures?()       
 *  - onOpenPlayers?()        
 *  - onOpenStandings?()      
 *  - onOpenPredictions?()    
 *  - onOpenContact?()
 *  - onGoHome?()
 */
export default function Navbar({
  brand = "English Premier League Data & Analytics",
  items = [
    { label: "Home", icon: <BarChart3 className="h-4 w-4" /> },
    { label: "Teams", icon: <Users2 className="h-4 w-4" /> },
    { label: "Fixtures", icon: <CalendarDays className="h-4 w-4" /> },
    { label: "Matches", icon: <Trophy className="h-4 w-4" /> },
    { label: "Players", icon: <User className="h-4 w-4" /> },
    { label: "FPL", icon: <TrendingUp className="h-4 w-4" /> }, // ✅ NEW
    { label: "Standings", icon: <LineChart className="h-4 w-4" /> },
  ],
  teams = [],
  onItemClick,
  onOpenTeam,
  onOpenResults,
  onOpenFixtures,
  onOpenPlayers,
  onOpenStandings,
  onOpenPredictions, // ✅ NEW
  onOpenContact,
  onGoHome,
  theme = "light",
  onToggleTheme,
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  // TEAMS dropdown (desktop)
  const [teamsOpen, setTeamsOpen] = useState(false);
  const teamsBtnRef = useRef(null);
  const teamsMenuRef = useRef(null);

  // Team search (desktop dropdown)
  const [teamQuery, setTeamQuery] = useState("");
  const sortedTeams = useMemo(() => [...teams].sort((a, b) => a.localeCompare(b)), [teams]);
  const filteredTeams = useMemo(() => {
    const q = teamQuery.trim().toLowerCase();
    if (!q) return sortedTeams;
    return sortedTeams.filter((t) => t.toLowerCase().includes(q));
  }, [sortedTeams, teamQuery]);

  // Close Teams menu on outside click / Esc
  useEffect(() => {
    function onDocClick(e) {
      if (!teamsOpen) return;
      const btn = teamsBtnRef.current;
      const menu = teamsMenuRef.current;
      if (!btn || !menu) return;
      if (btn.contains(e.target) || menu.contains(e.target)) return;
      setTeamsOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setTeamsOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [teamsOpen]);

  // Smooth scroll to top
  function scrollTopSmooth() {
    try {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      window.scrollTo(0, 0);
    }
  }

  // Home -> close modals + scroll to top
  function goHome() {
    onGoHome?.();
    scrollTopSmooth();
  }

  return (
    // Solid on mobile; translucent/blur on md+
    <header className="sticky top-0 z-[200] w-full border-b border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950 md:bg-white/80 md:backdrop-blur md:supports-[backdrop-filter]:bg-white/60 md:dark:bg-zinc-950/80 md:dark:supports-[backdrop-filter]:bg-zinc-950/60">
      <nav className="flex w-full items-center gap-3 px-4 py-2 md:px-6">
        {/* Left: Brand + mobile menu (no flex-grow) */}
        <div className="flex shrink-0 items-center gap-2">
          <button
            className="inline-flex items-center justify-center rounded-xl p-2 hover:bg-zinc-100 dark:hover:bg-zinc-900 md:hidden"
            aria-label="Open menu"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </button>

          <button
            type="button"
            onClick={goHome}
            className="group flex items-center gap-2"
            aria-label="Go to top"
          >
            <div className="grid h-8 w-8 place-items-center rounded-xl bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
              <span className="text-xs font-bold">TC</span>
            </div>
            <span className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              {brand}
            </span>
            <motion.span
              className="hidden h-[2px] w-0 rounded bg-zinc-900 dark:bg-zinc-100 md:block"
              initial={{ width: 0 }}
              whileHover={{ width: 32 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
            />
          </button>
        </div>

        {/* Center: primary nav (desktop) — now truly centered */}
        <div className="hidden flex-1 justify-center md:flex">
          <ul className="flex items-center gap-1">
            {items.map((it) => {
              const lower = (it.label || "").toLowerCase();
              const isTeamsAnchor = lower === "teams";

              if (!isTeamsAnchor) {
                const handleClick = () => {
                  if (lower === "matches") {
                    onOpenResults?.();
                  } else if (lower === "fixtures") {
                    onOpenFixtures?.();
                  } else if (lower === "players") {
                    onOpenPlayers?.();
                  } else if (lower === "standings" || lower === "league standings") {
                    onOpenStandings?.();
                  } else if (lower === "predictions" || lower === "fpl") {
                    onOpenPredictions?.(); // ✅ NEW
                  } else if (lower === "home") {
                    goHome();
                  } else {
                    onItemClick && onItemClick(it);
                  }
                };
                return (
                  <li key={it.label}>
                    <button
                      onClick={handleClick}
                      className="group inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-white"
                    >
                      {it.icon}
                      <span>{it.label}</span>
                      <motion.span
                        className="h-[2px] w-0 rounded bg-zinc-900 dark:bg-zinc-100"
                        initial={{ width: 0 }}
                        whileHover={{ width: 24 }}
                        transition={{ type: "spring", stiffness: 400, damping: 30 }}
                      />
                    </button>
                  </li>
                );
              }

              // TEAMS DROPDOWN (click) with logos + search
              return (
                <li key="teams" className="relative">
                  <button
                    ref={teamsBtnRef}
                    className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-white"
                    aria-haspopup="menu"
                    aria-expanded={teamsOpen}
                    onClick={() => {
                      setTeamsOpen((v) => !v);
                      setTeamQuery("");
                    }}
                  >
                    <Users2 className="h-4 w-4" />
                    <span>Teams</span>
                  </button>

                  <div
                    ref={teamsMenuRef}
                    className={`absolute left-0 top-full z-[201] mt-2 w-[28rem] max-h-[60vh] overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl outline-none transition dark:border-zinc-800 dark:bg-zinc-950 ${
                      teamsOpen
                        ? "pointer-events-auto opacity-100 translate-y-0"
                        : "pointer-events-none opacity-0 -translate-y-1"
                    }`}
                    role="menu"
                  >
                    {/* Search */}
                    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-zinc-200 bg-white/95 px-3 py-2 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
                      <Search className="h-4 w-4 text-zinc-500" />
                      <input
                        value={teamQuery}
                        onChange={(e) => setTeamQuery(e.target.value)}
                        placeholder="Search team…"
                        className="w-full bg-transparent text-sm outline-none placeholder:text-zinc-400"
                        autoFocus
                      />
                    </div>

                    {/* Teams grid */}
                    <div className="max-h-[50vh] overflow-auto p-2">
                      {filteredTeams.length === 0 ? (
                        <div className="px-3 py-6 text-sm text-zinc-500">
                          No matches for “{teamQuery}”.
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-1">
                          {filteredTeams.map((t) => (
                            <button
                              key={t}
                              onClick={() => {
                                onOpenTeam && onOpenTeam(t);
                                setTeamsOpen(false);
                              }}
                              role="menuitem"
                              className="flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900"
                            >
                              <img
                                src={logoUrl(t)}
                                alt=""
                                className="h-6 w-6 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
                                onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
                              />
                              <span className="font-medium">{t}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Right spacer to keep brand/center balanced */}
        <div className="ml-3 hidden items-center gap-2 md:flex">
          <button
            onClick={onToggleTheme}
            className="inline-flex items-center justify-center rounded-xl border border-zinc-200 px-2.5 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-900"
            aria-label="Toggle dark mode"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <button
            onClick={() => onOpenContact?.()}
            className="inline-flex items-center gap-2 rounded-xl bg-fuchsia-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-fuchsia-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-500/40 dark:bg-fuchsia-500 dark:hover:bg-fuchsia-600"
            aria-label="Open contact modal"
          >
            About
          </button>
        </div>
      </nav>

      {/* Mobile drawer (solid) */}
      <div
        className={`md:hidden ${mobileOpen ? "pointer-events-auto" : "pointer-events-none"} fixed inset-0 z-[210]`}
        aria-hidden={!mobileOpen}
      >
        <div
          className={`absolute inset-0 transition ${mobileOpen ? "bg-black/40" : "bg-transparent"}`}
          onClick={() => setMobileOpen(false)}
        />
        <aside
          className={`absolute left-0 top-0 h-full w-80 transform border-r border-zinc-200 bg-white p-4 shadow-xl transition-transform dark:border-zinc-800 dark:bg-zinc-950 ${
            mobileOpen ? "translate-x-0" : "-translate-x-full"
          }`}
          role="dialog"
          aria-label="Mobile menu"
        >
          <div className="mb-4 flex items-center justify-between">
            <button
              onClick={() => { goHome(); setMobileOpen(false); }}
              className="flex items-center gap-2"
              aria-label="Go to top"
            >
              <div className="grid h-8 w-8 place-items-center rounded-xl bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
                <span className="text-xs font-bold">xG</span>
              </div>
              <span className="text-lg font-semibold tracking-tight">{brand}</span>
            </button>
            <button
              onClick={onToggleTheme}
              className="rounded-xl px-3 py-1 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
              aria-label="Toggle dark mode"
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <button
              className="rounded-xl px-3 py-1 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
              onClick={() => setMobileOpen(false)}
            >
              Close
            </button>
          </div>

          {/* Quick links */}
          <div className="mb-4 grid grid-cols-2 gap-2">
            <button
              onClick={() => { goHome(); setMobileOpen(false); }}
              className="rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-900"
            >
              <BarChart3 className="mr-2 inline h-4 w-4" />
              Home
            </button>
            <button
              onClick={() => { onOpenResults?.(); setMobileOpen(false); }}
              className="rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-900"
            >
              <Trophy className="mr-2 inline h-4 w-4" />
              Matches
            </button>
            <button
              onClick={() => { onOpenFixtures?.(); setMobileOpen(false); }} // fixtures
              className="col-span-2 rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-900"
            >
              <CalendarDays className="mr-2 inline h-4 w-4" />
              Fixtures
            </button>
            <button
              onClick={() => { onOpenPlayers?.(); setMobileOpen(false); }} // players
              className="col-span-2 rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-900"
            >
              <User className="mr-2 inline h-4 w-4" />
              Players
            </button>
            <button
              onClick={() => { onOpenPredictions?.(); setMobileOpen(false); }}
              className="col-span-2 rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-900"
            >
              <TrendingUp className="mr-2 inline h-4 w-4" />
              FPL
            </button>
            {/* Contact CTA (mobile) */}
            <button
              onClick={() => { onOpenContact?.(); setMobileOpen(false); }}
              className="col-span-2 rounded-lg bg-fuchsia-600 px-3 py-2 text-left text-sm font-semibold text-white hover:bg-fuchsia-700 dark:bg-fuchsia-500 dark:hover:bg-fuchsia-600"
            >
              About
            </button>
          </div>

          {/* Teams list with logos */}
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Teams
          </div>
          <div className="grid grid-cols-1 gap-1">
            {sortedTeams.map((t) => (
              <button
                key={t}
                onClick={() => {
                  onOpenTeam && onOpenTeam(t);
                  setMobileOpen(false);
                }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900"
              >
                <img
                  src={logoUrl(t)}
                  alt=""
                  className="h-6 w-6 rounded bg-white object-contain ring-1 ring-zinc-200 dark:ring-zinc-700"
                  onError={(e) => (e.currentTarget.src = "/logos/_default.png")}
                />
                <span>{t}</span>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </header>
  );
}

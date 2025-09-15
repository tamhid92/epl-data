import React, { useEffect, useState } from "react";

import {
  X, Mail, Twitter, Github, Linkedin, Globe, BadgeInfo,
  ServerCog, GitBranch, Cloud, Image as ImageIcon
} from "lucide-react";

export default function ContactModal({
  open,
  onClose,
  ownerName,
  contact = {},
  ownerTitle,
  ownerIntro,
  diagramSrc = "/infra-diagram.png",
}) {
  const [imgOpen, setImgOpen] = useState(false);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") {
        if (imgOpen) { setImgOpen(false); return; }
        try { history.back(); } catch { onClose?.(); }
      }
    }
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, imgOpen, onClose]);

  if (!open) return null;

  const { email, twitter, github, linkedin, website } = contact;

  const LinkRow = ({ icon, href, label }) => {
    if (!href) return null;
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900"
      >
        {icon}
        <span className="truncate">{label}</span>
      </a>
    );
  };

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={() => { try { history.back(); } catch { onClose?.(); } }}
      />

      {/* Modal */}
      <div
        className="relative z-[501] w-full max-w-2xl rounded-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950
                   max-h-[85vh] overflow-auto" /* NEW: scrollable if tall */
      >
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-base font-semibold">Contact</h3>
          <button
            className="rounded-lg p-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
            onClick={() => { try { history.back(); } catch { onClose?.(); } }}
            aria-label="Close contact modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Intro / background */}
        <div className="mb-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm leading-relaxed text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
          <div className="mb-1 flex items-center gap-2 font-semibold">
            <BadgeInfo className="h-4 w-4" />
            <span>
              Hi, I’m {ownerName}{ownerTitle ? `, ${ownerTitle}` : ""}.
            </span>
          </div>
          <p className="text-sm">
            {ownerIntro ||
              "I work across data engineering and football analytics—building pipelines, models, and interactive visuals. This project explores performance trends and tactical signals from public match data."}
          </p>
        </div>

        {/* Links */}
        <div className="divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          <div className="grid">
            {email && (
              <a
                href={`mailto:${email}`}
                className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900"
              >
                <Mail className="h-4 w-4 text-rose-600" />
                <span>{email}</span>
              </a>
            )}
            <LinkRow icon={<Twitter className="h-4 w-4 text-sky-500" />} href={twitter} label={twitter} />
            <LinkRow icon={<Github className="h-4 w-4" />} href={github} label={github} />
            <LinkRow icon={<Linkedin className="h-4 w-4 text-sky-700" />} href={linkedin} label={linkedin} />
            <LinkRow icon={<Globe className="h-4 w-4" />} href={website} label={website} />
          </div>
        </div>

        {/* NEW: Maintained & Deployed explainer + diagram */}
        <div className="mt-4 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <ServerCog className="h-4 w-4" />
            <span>How this site is maintained & deployed</span>
          </div>

          {/* Diagram */}
          <div className="mb-3 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <div
              role="button"
              aria-label="Enlarge diagram"
              className="group relative cursor-zoom-in"
              onClick={() => setImgOpen(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setImgOpen(true);
                }
              }}
              tabIndex={0}
            >
              <img
                src={diagramSrc}
                alt="CI/CD, Cloudflare tunnel, and Kubernetes layout for this project"
                className="block w-full h-auto"
                onError={(e) => {
                  e.currentTarget.outerHTML = `
                    <div class="flex items-center gap-2 p-3 text-sm text-zinc-600 dark:text-zinc-300">
                      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M3 3l18 18M3 21l9-9 3 3 6 6" />
                      </svg>
                      <span>Diagram image not found. Place it at <code>/infra-diagram.png</code> or pass <code>diagramSrc</code>.</span>
                    </div>`;
                }}
              />
              {/* subtle hint on hover */}
              <div className="pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition-opacity group-hover:opacity-100">
                <span className="rounded-full bg-black/50 px-3 py-1 text-xs text-white">Click to enlarge</span>
              </div>
            </div>
          </div>

          {/* Bulleted explanation (kept short and skimmable) */}
          <ul className="space-y-2 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            <li className="flex gap-2">
              <GitBranch className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" />
              <span>
                <strong>Push to GitHub</strong> triggers GitHub Actions. The workflow runs tests, builds Docker images for the frontend, API, and data
                jobs, and pushes them to <code>ghcr.io</code>.
              </span>
            </li>
            <li className="flex gap-2">
              <ServerCog className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
              <span>
                A <strong>self-hosted runner / Jenkins job</strong> with RBAC deploys to Kubernetes via <code>kubectl rollout</code> against the cluster API.
              </span>
            </li>
            <li className="flex gap-2">
              <Cloud className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" />
              <span>
                The site is exposed through a <strong>Cloudflare Tunnel</strong> and DNS. Traffic hits NGINX Ingress → services (frontend/api) inside the
                <code> epl-data</code> namespace. Stateful data lives in a <strong>Postgres StatefulSet</strong> with a PVC.
              </span>
            </li>
            <li className="flex gap-2">
              <ImageIcon className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
              <span>
                <strong>Monitoring</strong>: Prometheus scrapes metrics; Grafana dashboards visualize them; Promtail ships logs to Loki for querying.
              </span>
            </li>
          </ul>

          <div className="mt-3 rounded-lg bg-zinc-50 p-2 text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
            Quick flow: push → Actions build & push image → kubelet pulls from GHCR → rollout updates Deployments (frontend, API, data-pipeline cronjob).
            Cloudflare Tunnel handles public access at <code>pl.tchowdhury.org</code>.
          </div>
        </div>

        <div className="mt-3 text-[11px] leading-relaxed text-zinc-500">
          I read every message, thanks for reaching out!
        </div>
      </div>
      {/* Image Lightbox */}
      {imgOpen && (
        <div
          className="fixed inset-0 z-[550] flex items-center justify-center p-4"
          onClick={() => setImgOpen(false)}
        >
          <div className="absolute inset-0 bg-black/70" />
          <div
            className="relative z-[551] max-w-[95vw] max-h-[95vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              aria-label="Close image"
              onClick={() => setImgOpen(false)}
              className="absolute -top-3 -right-3 rounded-full bg-white p-1.5 shadow ring-1 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:ring-zinc-700"
            >
              <X className="h-4 w-4" />
            </button>
            <img
              src={diagramSrc}
              alt="Full-size diagram"
              className="block max-h-[90vh] max-w-[90vw] rounded-lg shadow-2xl"
            />
          </div>
        </div>
      )}
    </div>
  );
}

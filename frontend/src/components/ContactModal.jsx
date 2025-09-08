import React, { useEffect } from "react";
import { X, Mail, Twitter, Github, Linkedin, Globe, BadgeInfo } from "lucide-react";

export default function ContactModal({
  open,
  onClose,
  ownerName,
  contact = {},
  ownerTitle,     // e.g. "Data Engineer & Football Analytics Enthusiast"
  ownerIntro,     // short paragraph about your background
}) {
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose?.(); }
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
      <div className="absolute inset-0 bg-black/40" onClick={() => onClose?.()} />

      {/* Modal */}
      <div className="relative z-[501] w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-base font-semibold">Contact</h3>
          <button
            className="rounded-lg p-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
            onClick={() => onClose?.()}
            aria-label="Close contact modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Intro / background */}
        <div
          className="mb-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm leading-relaxed text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
        >
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

        <div className="mt-3 text-[11px] leading-relaxed text-zinc-500">
          I read every message, thanks for reaching out!
        </div>
      </div>
    </div>
  );
}

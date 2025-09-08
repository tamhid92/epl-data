// components/ModalFrame.jsx
import React from "react";

/**
 * Generic centered modal frame that stays under a sticky navbar.
 * Props:
 *  - open: boolean
 *  - onClose: () => void
 *  - maxWidth?: tailwind width class (default: max-w-5xl)
 *  - children
 */
export default function ModalFrame({ open, onClose, maxWidth = "max-w-5xl", children }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90]">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* 
        Container under navbar:
        - top padding ~ navbar height (adjust if your navbar is taller)
        - ensure min-h-0 on panel so its children can scroll
      */}
      <div className="pointer-events-none absolute inset-x-0 top-[56px] bottom-0 flex items-start justify-center overflow-hidden">
        <div
          className={`pointer-events-auto m-4 w-full ${maxWidth} rounded-2xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950 
            flex flex-col max-h-[calc(100vh-80px)] min-h-0 overflow-hidden`}
          role="dialog"
          aria-modal="true"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

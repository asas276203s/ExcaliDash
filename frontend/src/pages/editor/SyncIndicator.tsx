import React from "react";
import { Loader2 } from "lucide-react";
import clsx from "clsx";

/**
 * SyncIndicator — remote-update feedback.
 *
 * Renders two layers, both keyed off `visible`:
 *
 *   1. Variant B (default) — a small bottom-right pill in the Linear/Notion
 *      "saving..." vibe. Non-blocking, does NOT intercept pointer events,
 *      and stays clear of Excalidraw's built-in zoom widget (which sits
 *      around bottom-right; we bump the pill up to `bottom-[88px]`).
 *      Wording: "同步中 · 遠端更新".
 *
 *   2. Variant C (escalated) — a subtle full-canvas backdrop plus a bigger
 *      centred pill near the top of the canvas. Signals "canvas is about to
 *      be replaced, hold on". Only shown when the apply is likely to be
 *      slow OR destructive:
 *
 *        - `escalated=true` is forwarded by the collab hook when either
 *          a) the pill has already been visible for ≥400ms and the fetch
 *             / apply still hasn't unlocked, or
 *          b) the diff between incoming and current elements replaces
 *             >30% of the canvas.
 *
 * The escalation is additive: Variant B stays visible underneath Variant C
 * so the eye's focus point (bottom-right corner) doesn't jump around.
 *
 * Accessibility: both layers are `role="status"` with `aria-live="polite"`
 * and `aria-busy` reflecting `visible`. The pill is the primary
 * announcement target so we set `role="status"` on it; the escalated
 * overlay is decorative for screen readers (`aria-hidden`).
 *
 * Pointer-events: the default pill has `pointer-events-none` — see BUG-16
 * — so canvas clicks pass straight through. The escalated overlay uses
 * `pointer-events-auto` deliberately: while it is up the apply is about
 * to swap the elements array, so silently swallowing stray clicks is
 * exactly what we want.
 */
export type SyncIndicatorProps = {
  visible: boolean;
  escalated?: boolean;
};

export const SyncIndicator: React.FC<SyncIndicatorProps> = ({
  visible,
  escalated = false,
}) => (
  <>
    <SyncPill visible={visible} />
    <SyncOverlay visible={visible && escalated} />
  </>
);

const SyncPill: React.FC<{ visible: boolean }> = ({ visible }) => (
  <div
    data-testid="remote-sync-pill"
    data-variant="B"
    role="status"
    aria-live="polite"
    aria-busy={visible ? "true" : "false"}
    aria-hidden={!visible}
    className={clsx(
      // Position: bottom-right of the canvas, above Excalidraw's zoom
      // widget which sits at bottom-right ~20px. 88px puts the pill
      // comfortably clear on both 1440x900 and 375x667 viewports.
      "absolute bottom-[88px] right-6 z-40",
      "inline-flex items-center gap-2",
      "px-3.5 py-2 rounded-full",
      "bg-white/98 dark:bg-neutral-900/98",
      "border border-gray-200 dark:border-neutral-800",
      "text-[13px] font-medium text-gray-900 dark:text-gray-100",
      "shadow-[0_2px_4px_rgba(0,0,0,0.04),0_12px_32px_rgba(15,23,42,0.08)]",
      "dark:shadow-[0_2px_4px_rgba(0,0,0,0.6),0_12px_32px_rgba(0,0,0,0.5)]",
      // Fade-in 250ms Linear ease-out, fade-out 200ms ease-out.
      "transition-[opacity,transform] duration-[250ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
      // pointer-events-none is the BUG-16 fix — never intercept canvas clicks.
      "pointer-events-none",
      visible
        ? "opacity-100 translate-y-0 scale-100"
        : "opacity-0 translate-y-2 scale-[0.96]",
    )}
  >
    <span
      data-testid="remote-sync-spinner"
      className={clsx(
        "inline-block w-3.5 h-3.5 rounded-full",
        "border-2 border-gray-200 dark:border-neutral-700",
        "border-t-indigo-500 dark:border-t-indigo-300",
        "animate-spin",
      )}
      aria-hidden="true"
    />
    <span>同步中</span>
    <span
      aria-hidden="true"
      className="w-px h-3 bg-gray-200 dark:bg-neutral-700"
    />
    <span className="text-gray-500 dark:text-gray-400 text-xs">
      遠端更新
    </span>
  </div>
);

const SyncOverlay: React.FC<{ visible: boolean }> = ({ visible }) => (
  <div
    data-testid="remote-sync-overlay"
    data-variant="C"
    aria-hidden="true"
    className={clsx(
      "absolute inset-0 z-30 flex items-start justify-center",
      "pt-[15vh]",
      // Subtle canvas dim + light blur. Enough to focus attention on
      // the pill without hiding content.
      "bg-slate-900/[0.04] dark:bg-black/[0.12]",
      "backdrop-blur-[1px]",
      "transition-opacity duration-200 ease-out",
      visible
        ? "opacity-100 pointer-events-auto cursor-progress"
        : "opacity-0 pointer-events-none",
    )}
  >
    <div
      className={clsx(
        "inline-flex items-center gap-3",
        "px-5 py-3 rounded-full",
        "bg-white/98 dark:bg-neutral-900/98",
        "border border-gray-200 dark:border-neutral-800",
        "text-sm font-medium text-gray-900 dark:text-gray-100",
        "shadow-[0_4px_8px_rgba(0,0,0,0.06),0_20px_40px_rgba(15,23,42,0.12)]",
        "dark:shadow-[0_4px_8px_rgba(0,0,0,0.6),0_20px_40px_rgba(0,0,0,0.6)]",
        "transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
        visible ? "translate-y-0 scale-100" : "-translate-y-1.5 scale-[0.96]",
      )}
    >
      <Loader2
        size={16}
        className="animate-spin text-indigo-500 dark:text-indigo-300"
        aria-hidden="true"
      />
      <span>同步中</span>
      <span
        aria-hidden="true"
        className="w-px h-3.5 bg-gray-200 dark:bg-neutral-700"
      />
      <span className="text-gray-500 dark:text-gray-400 text-xs">
        畫布即將更新
      </span>
    </div>
  </div>
);

export default SyncIndicator;

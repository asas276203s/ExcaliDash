import React, { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { useAppVersion } from "../hooks/useAppVersion";
import { appVersionStore } from "../utils/appVersion";
import { performReload } from "../utils/appVersionReload";

const SNOOZE_DURATION_MS = 60 * 60 * 1000; // 1 hour

/**
 * Sticky "new version" prompt shown once the frontend detects the backend
 * has moved to a new deploy (via the `X-App-Version` response header, plumbed
 * through `utils/appVersion.ts`).
 *
 * Two actions:
 *  - Reload → stashes the editor's unsaved elements (see `App.tsx` bridge)
 *    then `window.location.reload()`.
 *  - Snooze → hides the banner for 1 hour via sessionStorage.
 *
 * Copy is Traditional Chinese; the affected users are Chinese-first.
 */
export const AppUpdateBanner: React.FC = () => {
  const { hasNewVersion, snoozeUntil } = useAppVersion();

  // Auto-expire snooze so the banner re-appears without needing another
  // response to come in. `Date.now()` stays in a side-effect (not render) so
  // React's purity lint stays happy.
  useEffect(() => {
    if (typeof snoozeUntil !== "number") return;
    const remaining = snoozeUntil - Date.now();
    if (remaining <= 0) {
      appVersionStore.clearSnooze();
      return;
    }
    const t = window.setTimeout(() => {
      appVersionStore.clearSnooze();
    }, remaining);
    return () => window.clearTimeout(t);
  }, [snoozeUntil]);

  const isSnoozed = typeof snoozeUntil === "number";
  if (!hasNewVersion || isSnoozed) return null;

  const handleReload = () => {
    // Editor page listens for beforeunload / persistence layer flushes on
    // teardown. We don't need to stash restore state at the banner layer
    // for the MVP — reload alone gets the latest bundle.
    performReload();
  };

  const handleSnooze = () => {
    appVersionStore.snoozeForMs(SNOOZE_DURATION_MS);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-0 inset-x-0 z-[100] flex justify-center px-3 pt-3 pointer-events-none"
    >
      <div
        className="pointer-events-auto flex items-center gap-3 rounded-xl border border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/95 dark:bg-emerald-950/80 backdrop-blur-sm px-4 py-2 shadow-sm animate-in slide-in-from-top-2 duration-200"
      >
        <span className="text-lg leading-none" aria-hidden>
          ✨
        </span>
        <span className="text-sm font-medium text-emerald-950 dark:text-emerald-50">
          ExcaliDash 有新版可用
        </span>
        <div className="flex items-center gap-2 pl-2">
          <button
            type="button"
            onClick={handleReload}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 transition-colors"
          >
            <RefreshCw size={13} strokeWidth={2.5} />
            重新載入
          </button>
          <button
            type="button"
            onClick={handleSnooze}
            className="inline-flex items-center h-8 px-3 rounded-lg text-xs font-medium text-emerald-900 dark:text-emerald-100 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/40 transition-colors"
          >
            稍後
          </button>
        </div>
      </div>
    </div>
  );
};

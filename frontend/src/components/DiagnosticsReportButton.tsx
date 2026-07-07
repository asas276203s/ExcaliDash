import React, { useState } from "react";
import { toast } from "sonner";
import { diagnostics } from "../lib/diagnostics";

/**
 * Low-profile "回報問題" entry point pinned to the bottom-left of the editor.
 * Pressing it flushes the current diagnostics ring buffer to the backend so
 * the user can report a problem (e.g. a transient blank canvas that recovered)
 * with the exact trace attached.
 */
export const DiagnosticsReportButton: React.FC = () => {
  const [busy, setBusy] = useState(false);

  const handleClick = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    diagnostics.log("manual-report-clicked");
    const ok = await diagnostics.flush("manual");
    setBusy(false);
    if (ok) {
      toast.success("已送出診斷資料、感謝回報");
    } else {
      toast.error("目前沒有可回報的資料或送出失敗");
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      title="回報畫布或同步問題，附上診斷資料"
      className="fixed bottom-3 left-3 z-40 px-2.5 py-1.5 rounded-md text-xs font-medium text-gray-500 dark:text-gray-400 bg-white/80 dark:bg-neutral-900/80 border border-gray-200 dark:border-neutral-800 shadow-sm backdrop-blur hover:text-gray-800 dark:hover:text-gray-200 hover:bg-white dark:hover:bg-neutral-900 disabled:opacity-60 transition-colors"
    >
      {busy ? "傳送中…" : "回報問題"}
    </button>
  );
};

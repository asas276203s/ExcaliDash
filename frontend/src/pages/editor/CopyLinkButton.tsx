import React, { useState } from "react";
import { Check, Link as LinkIcon } from "lucide-react";
import { copyText } from "../../utils/copyText";

/**
 * Copy the current drawing's URL straight from the editor header.
 *
 * Deliberately not gated on ownership: the link grants nothing by itself (the
 * server still checks access on open), and needing it is independent of who
 * may change the sharing settings.
 *
 * Its own component so EditorView can stay an expression-bodied render
 * function — the copied/idle flag is local to this button.
 */
export const CopyLinkButton: React.FC<{ drawingId: string }> = ({
  drawingId,
}) => {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        const ok = await copyText(
          `${window.location.origin}/editor/${drawingId}`,
        );
        if (!ok) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
      title={copied ? "Link copied" : "Copy link"}
      aria-label="Copy link to this drawing"
      className={
        copied
          ? "p-2 rounded-lg text-emerald-600 dark:text-emerald-400 transition-colors"
          : "p-2 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded-lg text-gray-600 dark:text-gray-300 transition-colors"
      }
    >
      {copied ? <Check size={20} strokeWidth={2.5} /> : <LinkIcon size={20} />}
    </button>
  );
};

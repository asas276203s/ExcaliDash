import { useEffect } from "react";

/**
 * Keyboard shortcuts for the multi-tab board.
 *
 *   - Cmd/Ctrl+W          → close active tab
 *   - Cmd/Ctrl+Shift+T    → reopen last closed tab
 *
 * All handlers early-out on `e.isComposing` so IME users typing in Bopomofo
 * (or any composed input) never trigger a stray close.
 */
export interface UseTabsKeyboardParams {
  activeId: string | null;
  hasClosedHistory: boolean;
  onCloseActive: () => void;
  onReopenLastClosed: () => void;
  enabled?: boolean;
}

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    // We still want Cmd+W to close even inside the rename input, but the
    // Excalidraw canvas registers many keys via contenteditable/focused
    // divs — skipping editable targets for reopen is safer.
    return false;
  }
  return target.isContentEditable === true;
};

export const useTabsKeyboard = ({
  activeId,
  hasClosedHistory,
  onCloseActive,
  onReopenLastClosed,
  enabled = true,
}: UseTabsKeyboardParams): void => {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;

      const key = event.key.toLowerCase();

      // Cmd/Ctrl+Shift+T: reopen last closed
      if (event.shiftKey && key === "t") {
        if (!hasClosedHistory) return;
        event.preventDefault();
        event.stopPropagation();
        onReopenLastClosed();
        return;
      }

      // Cmd/Ctrl+W: close active tab
      if (!event.shiftKey && !event.altKey && key === "w") {
        if (!activeId) return;
        // Skip if focus is on a text field the user is actively editing —
        // Cmd+W in browsers still closes tabs, but inside our SPA we don't
        // want it to fire when the user is mid-word.
        if (isEditableTarget(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseActive();
        return;
      }
    };

    window.addEventListener("keydown", handler, { capture: true });
    return () => {
      window.removeEventListener("keydown", handler, { capture: true } as any);
    };
  }, [activeId, hasClosedHistory, onCloseActive, onReopenLastClosed, enabled]);
};

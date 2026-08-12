import { useCallback, useEffect, useRef } from "react";
import { type UseTabsResult } from "./useTabs";
import { useTabsContext } from "../../context/TabsContext";
import { useTabsKeyboard } from "./useTabsKeyboard";
import * as api from "../../api";

/**
 * Wires the multi-tab state, keyboard shortcuts, and drawing-name -> tab-title
 * sync in one place so Editor.tsx stays focused on orchestration.
 */
export interface UseEditorTabsParams {
  drawingId: string | undefined;
  drawingName: string;
}

export interface UseEditorTabsResult extends UseTabsResult {
  handleCloseActiveTab: () => void;
}

export const useEditorTabs = ({
  drawingId,
  drawingName,
}: UseEditorTabsParams): UseEditorTabsResult => {
  // Read shared tab state from the app-level provider so the Layout's tab
  // bar and the Editor stay in lockstep. The drawingId argument is
  // preserved to match the previous signature but is no longer used to
  // instantiate a new hook — the provider derives the current id from the
  // router match.
  const tabsApi = useTabsContext();
  const { updateTabName, closeTab, reopenLastClosed, activeId, hasClosedHistory } =
    tabsApi;

  // Keep tab titles in sync with the loaded drawing name. Skip the initial
  // placeholder so we don't clobber cached names before the fetch resolves.
  useEffect(() => {
    if (!drawingId) return;
    if (!drawingName) return;
    if (drawingName === "Drawing Editor") return;
    updateTabName(drawingId, drawingName);
  }, [drawingId, drawingName, updateTabName]);

  // Back-fill titles for tabs we have never opened this session.
  //
  // The effect above only names the drawing currently in the editor, and
  // `updateTabName` is the only writer of `StoredTab.name`. So a workspace
  // restored from localStorage (or widened by a shared `?tabs=` link) renders
  // every not-yet-visited tab as `fallbackName(id)` — a truncated uuid like
  // "86cc5e94…". Fetch the missing names in one request instead.
  //
  // `attemptedRef` makes each id at-most-once per mount: ids the caller cannot
  // access are absent from the response (by design — see the server's `?ids=`
  // handler), and without this guard they would refetch on every tabs change.
  const { tabs } = tabsApi;
  const attemptedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const missing = tabs
      .filter((tab) => !tab.name?.trim() && !attemptedRef.current.has(tab.id))
      .map((tab) => tab.id);
    if (missing.length === 0) return;

    missing.forEach((id) => attemptedRef.current.add(id));
    const controller = new AbortController();
    void api
      .getDrawingSummariesByIds(missing, { signal: controller.signal })
      .then((summaries) => {
        summaries.forEach((summary) => {
          if (summary.name?.trim()) updateTabName(summary.id, summary.name);
        });
      })
      .catch(() => {
        // Labels are cosmetic: on failure the tabs keep their uuid fallback.
        // Clear the guard so a later tabs change can retry.
        missing.forEach((id) => attemptedRef.current.delete(id));
      });

    return () => controller.abort();
  }, [tabs, updateTabName]);

  const handleCloseActiveTab = useCallback(() => {
    if (!drawingId) return;
    closeTab(drawingId);
  }, [drawingId, closeTab]);

  useTabsKeyboard({
    activeId,
    hasClosedHistory,
    onCloseActive: handleCloseActiveTab,
    onReopenLastClosed: reopenLastClosed,
  });

  return { ...tabsApi, handleCloseActiveTab };
};

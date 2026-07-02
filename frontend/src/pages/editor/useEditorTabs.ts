import { useCallback, useEffect } from "react";
import { type UseTabsResult } from "./useTabs";
import { useTabsContext } from "../../context/TabsContext";
import { useTabsKeyboard } from "./useTabsKeyboard";

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

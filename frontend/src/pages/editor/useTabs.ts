import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  buildTabsSearch,
  parseTabsFromSearch,
  popClosedTab,
  pushClosedTab,
  readClosedTabs,
  readOpenTabs,
  readActiveTab,
  writeActiveTab,
  writeOpenTabs,
  type StoredTab,
} from "../../utils/tabsStorage";

export interface EditorTab {
  id: string;
  name?: string;
}

export interface UseTabsResult {
  tabs: EditorTab[];
  activeId: string | null;
  openTab: (id: string, opts?: { activate?: boolean; name?: string }) => void;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  updateTabName: (id: string, name: string) => void;
  reopenLastClosed: () => void;
  hasClosedHistory: boolean;
}

const areTabListsEqual = (a: EditorTab[], b: EditorTab[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
    if ((a[i].name || "") !== (b[i].name || "")) return false;
  }
  return true;
};

const withEnsuredId = (
  list: EditorTab[],
  id: string | undefined,
): EditorTab[] => {
  if (!id) return list;
  if (list.some((t) => t.id === id)) return list;
  return [...list, { id }];
};

/**
 * Multi-tab state for the Editor page.
 *
 * Hydration priority (mount): URL query -> localStorage -> single tab from :id.
 * Every mutation is mirrored to localStorage AND the URL query string.
 * Route navigation (path change) is the way we switch which drawing loads —
 * the tab bar drives navigate() and the current `:id` param drives activeId.
 */
export const useTabs = (currentDrawingId: string | undefined): UseTabsResult => {
  const navigate = useNavigate();
  const location = useLocation();
  const hasHydratedRef = useRef(false);

  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [hasClosedHistory, setHasClosedHistory] = useState<boolean>(
    () => readClosedTabs().length > 0,
  );

  // Hydrate once on mount from URL/localStorage.
  useEffect(() => {
    if (hasHydratedRef.current) return;
    hasHydratedRef.current = true;
    const { tabIds } = parseTabsFromSearch(location.search);
    const storedTabs = readOpenTabs();
    let initial: EditorTab[];
    if (tabIds && tabIds.length > 0) {
      // Prefer URL-declared order, but re-use cached names if present.
      const nameById = new Map(storedTabs.map((t) => [t.id, t.name]));
      initial = tabIds.map((id) => ({ id, name: nameById.get(id) }));
    } else {
      initial = storedTabs.map((t) => ({ id: t.id, name: t.name }));
    }
    initial = withEnsuredId(initial, currentDrawingId);
    setTabs(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the current drawing id represented as an open tab.
  useEffect(() => {
    if (!currentDrawingId) return;
    if (!hasHydratedRef.current) return;
    setTabs((prev) => withEnsuredId(prev, currentDrawingId));
  }, [currentDrawingId]);

  // Sync tabs -> localStorage + URL.
  const syncPersistence = useCallback(
    (nextTabs: EditorTab[], nextActive: string | null) => {
      const storedShape: StoredTab[] = nextTabs.map((t) => ({
        id: t.id,
        name: t.name,
      }));
      writeOpenTabs(storedShape);
      writeActiveTab(nextActive);
      const nextSearch = buildTabsSearch(
        location.search,
        nextTabs.map((t) => t.id),
        nextActive,
      );
      if (nextSearch !== location.search) {
        navigate(
          { pathname: location.pathname, search: nextSearch, hash: location.hash },
          { replace: true },
        );
      }
    },
    [location.hash, location.pathname, location.search, navigate],
  );

  // React to tabs state changes: persist.
  useEffect(() => {
    if (!hasHydratedRef.current) return;
    syncPersistence(tabs, currentDrawingId || readActiveTab());
  }, [tabs, currentDrawingId, syncPersistence]);

  const openTab: UseTabsResult["openTab"] = useCallback(
    (id, opts) => {
      if (!id) return;
      const shouldActivate = opts?.activate !== false;
      setTabs((prev) => {
        if (prev.some((t) => t.id === id)) {
          if (opts?.name) {
            return prev.map((t) => (t.id === id ? { ...t, name: opts.name } : t));
          }
          return prev;
        }
        return [...prev, { id, name: opts?.name }];
      });
      if (shouldActivate) {
        navigate(`/editor/${id}${location.search}${location.hash}`);
      }
    },
    [location.hash, location.search, navigate],
  );

  const closeTab: UseTabsResult["closeTab"] = useCallback(
    (id) => {
      setTabs((prev) => {
        const closing = prev.find((t) => t.id === id);
        if (!closing) return prev;
        pushClosedTab({ id: closing.id, name: closing.name });
        setHasClosedHistory(true);
        const remaining = prev.filter((t) => t.id !== id);
        // If we're closing the active tab, navigate to a neighbour.
        if (currentDrawingId === id) {
          const index = prev.findIndex((t) => t.id === id);
          const nextTab = remaining[index] || remaining[index - 1] || null;
          if (nextTab) {
            navigate(`/editor/${nextTab.id}`);
          } else {
            navigate(`/`);
          }
        }
        return remaining;
      });
    },
    [currentDrawingId, navigate],
  );

  const activateTab: UseTabsResult["activateTab"] = useCallback(
    (id) => {
      if (!id) return;
      if (id === currentDrawingId) return;
      navigate(`/editor/${id}${location.search}${location.hash}`);
    },
    [currentDrawingId, location.hash, location.search, navigate],
  );

  const updateTabName: UseTabsResult["updateTabName"] = useCallback(
    (id, name) => {
      if (!id || !name) return;
      setTabs((prev) => {
        const target = prev.find((t) => t.id === id);
        if (!target) return prev;
        if (target.name === name) return prev;
        const next = prev.map((t) => (t.id === id ? { ...t, name } : t));
        if (areTabListsEqual(prev, next)) return prev;
        return next;
      });
    },
    [],
  );

  const reopenLastClosed: UseTabsResult["reopenLastClosed"] = useCallback(() => {
    const restored = popClosedTab();
    setHasClosedHistory(readClosedTabs().length > 0);
    if (!restored) return;
    setTabs((prev) => {
      if (prev.some((t) => t.id === restored.id)) return prev;
      return [...prev, { id: restored.id, name: restored.name }];
    });
    navigate(`/editor/${restored.id}${location.search}${location.hash}`);
  }, [location.hash, location.search, navigate]);

  return useMemo(
    () => ({
      tabs,
      activeId: currentDrawingId || null,
      openTab,
      closeTab,
      activateTab,
      updateTabName,
      reopenLastClosed,
      hasClosedHistory,
    }),
    [
      tabs,
      currentDrawingId,
      openTab,
      closeTab,
      activateTab,
      updateTabName,
      reopenLastClosed,
      hasClosedHistory,
    ],
  );
};

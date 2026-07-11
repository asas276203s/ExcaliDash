import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  applyTabMove,
  buildTabsSearch,
  parseTabsFromSearch,
  popClosedTab,
  pushClosedTab,
  readClosedTabs,
  readOpenTabs,
  readActiveTab,
  writeActiveTab,
  writeOpenTabs,
  isTabsHiddenPath,
  stripTabsFromSearch,
  mergeStoredTabsWithUrl,
  type StoredTab,
} from "../../utils/tabsStorage";

export interface EditorTab {
  id: string;
  name?: string;
}

export interface UseTabsResult {
  tabs: EditorTab[];
  activeId: string | null;
  openTab: (
    id: string,
    opts?: {
      activate?: boolean;
      name?: string;
      /**
       * Whether to carry the CALLER's current `location.search`/`hash` onto
       * the destination `/editor/:id` URL. Defaults to true (existing
       * in-editor callers rely on this to preserve the `?tabs=`/`active=`
       * mirror). Pass `false` when opening from a route whose search params
       * are unrelated to the editor (e.g. Dashboard's `?id=<collectionId>`
       * filter) so they don't leak onto the editor URL.
       */
      preserveSearch?: boolean;
    },
  ) => void;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  updateTabName: (id: string, name: string) => void;
  reopenLastClosed: () => void;
  moveTab: (fromId: string, toIndex: number) => void;
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
 * Source of truth: localStorage IS the workspace. The URL `?tabs=` param is an
 * optional layout mirror that can REORDER or ADD tabs but must never SHRINK the
 * workspace (see `mergeStoredTabsWithUrl`).
 *
 * Hydration runs on mount AND again whenever we return from a "tab-hidden"
 * route (`/shared`, auth pages). Those routes deliberately empty the in-memory
 * `tabs` (privacy: the tab bar must not exist there) WITHOUT touching
 * localStorage — so on the way back we must re-read the workspace from
 * localStorage instead of persisting the emptied state over it. The persistence
 * gate below stops that transient empty/collapsed state from ever being written.
 */
export const useTabs = (currentDrawingId: string | undefined): UseTabsResult => {
  const navigate = useNavigate();
  const location = useLocation();
  const hasHydratedRef = useRef(false);
  // True while the previous route was tab-hidden (`/shared`, auth). Drives a
  // re-hydration when we return to a visible route.
  const wasHiddenRef = useRef(false);
  // Set by (re)hydration to tell the persistence effect to skip the very next
  // run: that run still sees the pre-hydration `tabs` value (React commits the
  // hydration `setTabs` on the following render), so persisting it would write
  // the stale/collapsed set over localStorage.
  const skipNextPersistRef = useRef(false);

  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [hasClosedHistory, setHasClosedHistory] = useState<boolean>(
    () => readClosedTabs().length > 0,
  );

  // Hydrate on mount, and re-hydrate when leaving a tab-hidden route.
  useEffect(() => {
    // On `/shared/:id` (and auth pages) the tab workspace must not exist: never
    // ingest `?tabs=` from the URL, since those ids belong to the sharer's other
    // drawings and would leak into a link-share view. localStorage is left
    // untouched so the owner's real workspace survives the visit.
    if (isTabsHiddenPath(location.pathname)) {
      wasHiddenRef.current = true;
      hasHydratedRef.current = true;
      setTabs([]);
      // Scrub any tab params that rode in on the URL so a shared link can't be
      // re-forwarded still carrying the owner's other drawing ids.
      const strippedSearch = stripTabsFromSearch(location.search);
      if (strippedSearch !== location.search) {
        navigate(
          {
            pathname: location.pathname,
            search: strippedSearch,
            hash: location.hash,
          },
          { replace: true },
        );
      }
      return;
    }
    const returningFromHidden = wasHiddenRef.current;
    wasHiddenRef.current = false;
    // Only hydrate on first mount or when coming back from a hidden route.
    // Plain editor<->editor navigation keeps the live in-memory workspace.
    if (hasHydratedRef.current && !returningFromHidden) return;
    hasHydratedRef.current = true;
    const { tabIds } = parseTabsFromSearch(location.search);
    // localStorage is the source of truth; the URL may only reorder/extend it.
    const merged = mergeStoredTabsWithUrl(readOpenTabs(), tabIds);
    const initial = withEnsuredId(
      merged.map((t) => ({ id: t.id, name: t.name })),
      currentDrawingId,
    );
    skipNextPersistRef.current = true;
    setTabs(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

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
    // Never write tab params into a shared/auth URL or clobber the URL there.
    // localStorage is left untouched so the owner's real workspace survives.
    if (isTabsHiddenPath(location.pathname)) return;
    // Skip the run that still holds the pre-hydration `tabs` value — persisting
    // it would write a stale/collapsed set over the freshly hydrated workspace.
    // The subsequent render (with the hydrated tabs) persists the real state.
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    syncPersistence(tabs, currentDrawingId || readActiveTab());
  }, [tabs, currentDrawingId, syncPersistence, location.pathname]);

  const openTab: UseTabsResult["openTab"] = useCallback(
    (id, opts) => {
      if (!id) return;
      const shouldActivate = opts?.activate !== false;
      const preserveSearch = opts?.preserveSearch !== false;
      const next = tabs.some((t) => t.id === id)
        ? opts?.name
          ? tabs.map((t) => (t.id === id ? { ...t, name: opts.name } : t))
          : tabs
        : [...tabs, { id, name: opts?.name }];
      // Only if this call actually changes the route (not a no-op re-open of
      // the already-active tab) do we need to worry about the race below.
      const willChangeRoute = shouldActivate && id !== currentDrawingId;

      if (willChangeRoute) {
        // Persist + navigate to the FULL destination (pathname AND the
        // `?tabs=`/`active=` query) ourselves, right here, and tell the
        // "sync tabs -> localStorage + URL" effect below to skip its next
        // run (same `skipNextPersistRef` mechanism hydration uses above).
        //
        // That effect independently calls navigate() whenever `tabs` or
        // `currentDrawingId` change — and here we're changing BOTH in the
        // same tick (setTabs below + this navigate). Two independent
        // navigate() calls firing together can race: the second can resolve
        // against a location snapshot that predates the first, silently
        // reverting the route. Doing the (one, complete) navigation
        // ourselves and skipping the effect's redundant one avoids ever
        // creating that race.
        skipNextPersistRef.current = true;
        writeOpenTabs(next.map((t) => ({ id: t.id, name: t.name })));
        writeActiveTab(id);
        const searchBase = preserveSearch ? location.search : "";
        const hash = preserveSearch ? location.hash : "";
        const nextSearch = buildTabsSearch(searchBase, next.map((t) => t.id), id);
        navigate(`/editor/${id}${nextSearch}${hash}`);
      }
      if (next !== tabs) {
        setTabs(next);
      }
    },
    [tabs, currentDrawingId, location.hash, location.search, navigate],
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

  const moveTab: UseTabsResult["moveTab"] = useCallback((fromId, toIndex) => {
    if (!fromId) return;
    setTabs((prev) => applyTabMove(prev, fromId, toIndex));
  }, []);

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
      moveTab,
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
      moveTab,
      hasClosedHistory,
    ],
  );
};

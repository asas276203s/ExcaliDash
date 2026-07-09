/**
 * Storage helpers for the multi-tab board feature.
 *
 * Persists across refresh via localStorage AND URL query params so users can
 * share workspace layouts (URL is source of truth on mount, localStorage
 * is a fallback).
 */

export interface StoredTab {
  id: string;
  name?: string;
}

export const OPEN_TABS_KEY = "excalidash.open-tabs";
export const ACTIVE_TAB_KEY = "excalidash.active-tab";
export const CLOSED_TABS_KEY = "excalidash.closed-tabs";

const MAX_CLOSED_HISTORY = 20;

const safeParse = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const isValidId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const dedupeById = (tabs: StoredTab[]): StoredTab[] => {
  const seen = new Set<string>();
  const out: StoredTab[] = [];
  for (const tab of tabs) {
    if (!isValidId(tab?.id)) continue;
    if (seen.has(tab.id)) continue;
    seen.add(tab.id);
    out.push({ id: tab.id, name: tab.name });
  }
  return out;
};

export const readOpenTabs = (): StoredTab[] => {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(OPEN_TABS_KEY);
  const parsed = safeParse<unknown[]>(raw, []);
  if (!Array.isArray(parsed)) return [];
  const mapped: StoredTab[] = [];
  for (const entry of parsed) {
    if (typeof entry === "string") {
      if (isValidId(entry)) mapped.push({ id: entry });
      continue;
    }
    if (entry && typeof entry === "object" && "id" in entry) {
      const asObj = entry as StoredTab;
      if (isValidId(asObj.id)) mapped.push({ id: asObj.id, name: asObj.name });
    }
  }
  return dedupeById(mapped);
};

export const writeOpenTabs = (tabs: StoredTab[]): void => {
  if (typeof window === "undefined") return;
  const clean = dedupeById(tabs);
  window.localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(clean));
};

export const readActiveTab = (): string | null => {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(ACTIVE_TAB_KEY);
  return isValidId(value) ? value : null;
};

export const writeActiveTab = (id: string | null): void => {
  if (typeof window === "undefined") return;
  if (isValidId(id)) {
    window.localStorage.setItem(ACTIVE_TAB_KEY, id);
  } else {
    window.localStorage.removeItem(ACTIVE_TAB_KEY);
  }
};

export const readClosedTabs = (): StoredTab[] => {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(CLOSED_TABS_KEY);
  const parsed = safeParse<unknown[]>(raw, []);
  if (!Array.isArray(parsed)) return [];
  const mapped: StoredTab[] = [];
  for (const entry of parsed) {
    if (entry && typeof entry === "object" && "id" in entry) {
      const asObj = entry as StoredTab;
      if (isValidId(asObj.id)) mapped.push({ id: asObj.id, name: asObj.name });
    }
  }
  return mapped.slice(0, MAX_CLOSED_HISTORY);
};

export const writeClosedTabs = (tabs: StoredTab[]): void => {
  if (typeof window === "undefined") return;
  const trimmed = tabs.slice(0, MAX_CLOSED_HISTORY);
  window.localStorage.setItem(CLOSED_TABS_KEY, JSON.stringify(trimmed));
};

export const pushClosedTab = (tab: StoredTab): void => {
  const current = readClosedTabs();
  const next = [tab, ...current.filter((t) => t.id !== tab.id)];
  writeClosedTabs(next);
};

export const popClosedTab = (): StoredTab | null => {
  const current = readClosedTabs();
  if (current.length === 0) return null;
  const [head, ...rest] = current;
  writeClosedTabs(rest);
  return head;
};

/**
 * Route prefixes on which the multi-tab workspace must NEVER be read from the
 * URL, rendered, or persisted.
 *
 * `/shared/:id` is a single-drawing link-share view. The tab list encodes the
 * ids (and cached names) of the OWNER's other open drawings, so honoring
 * `?tabs=` or rendering the tab bar there leaks which other drawings exist —
 * a privacy bug. Auth pages never show a workspace either.
 */
export const TABS_HIDDEN_ROUTE_PREFIXES = [
  "/login",
  "/register",
  "/reset-password",
  "/reset-password-confirm",
  "/auth-setup",
  "/shared/",
  "/shared",
] as const;

export const isTabsHiddenPath = (pathname: string): boolean =>
  TABS_HIDDEN_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix));

/**
 * Remove the tab-workspace params (`tabs`, `active`) from a search string while
 * preserving any unrelated params. Used when redirecting into the shared route
 * so the owner's open-tab list never rides along into a link-share URL.
 */
export const stripTabsFromSearch = (search: string): string =>
  buildTabsSearch(search, [], null);

export interface ParsedTabsFromUrl {
  tabIds: string[] | null;
  activeId: string | null;
}

export const parseTabsFromSearch = (search: string): ParsedTabsFromUrl => {
  const params = new URLSearchParams(search);
  const tabsRaw = params.get("tabs");
  const activeRaw = params.get("active");
  const tabIds = tabsRaw
    ? tabsRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => isValidId(s))
    : null;
  const activeId = isValidId(activeRaw) ? activeRaw : null;
  return { tabIds, activeId };
};

/**
 * Merge the persisted workspace (localStorage — the source of truth) with the
 * tab ids declared on the URL `?tabs=` param.
 *
 * The URL param is only ever emitted by our own persistence code as a shareable
 * mirror of the workspace; there is NO curated "share this exact tab layout"
 * feature (link-sharing uses `/shared/:id`). Therefore the URL must never be
 * able to SHRINK the workspace — otherwise a stale/partial `?tabs=` (e.g. a
 * single-tab editor URL) silently drops every other open drawing and the loss
 * is then written back to localStorage, permanently destroying the workspace.
 *
 * Strategy (union): honour the URL's ORDER for the ids it lists, then append
 * any stored tabs the URL omitted (preserving their stored order). Cached names
 * from localStorage are reused. The result is never smaller than `stored`.
 */
export const mergeStoredTabsWithUrl = (
  stored: StoredTab[],
  urlIds: string[] | null,
): StoredTab[] => {
  const cleanStored = dedupeById(stored);
  if (!urlIds || urlIds.length === 0) {
    return cleanStored;
  }
  const nameById = new Map(cleanStored.map((t) => [t.id, t.name]));
  const seen = new Set<string>();
  const out: StoredTab[] = [];
  for (const id of urlIds) {
    if (!isValidId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: nameById.get(id) });
  }
  for (const t of cleanStored) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push({ id: t.id, name: t.name });
  }
  return out;
};

/**
 * Build a query-string patch that reflects the given tabs + active id. Merges
 * into an existing search string so unrelated params (e.g. import links) are
 * preserved.
 */
export const buildTabsSearch = (
  currentSearch: string,
  tabIds: string[],
  activeId: string | null,
): string => {
  const params = new URLSearchParams(currentSearch);
  if (tabIds.length > 0) {
    params.set("tabs", tabIds.join(","));
  } else {
    params.delete("tabs");
  }
  if (activeId) {
    params.set("active", activeId);
  } else {
    params.delete("active");
  }
  const str = params.toString();
  return str ? `?${str}` : "";
};

/**
 * Add a drawing to the open-tabs list without replacing the active tab.
 * Used by the Dashboard/DrawingCard so a fresh drawing opened from the grid
 * shows up as a new tab in the Editor.
 */
export const appendTabToStorage = (tab: StoredTab): void => {
  const current = readOpenTabs();
  if (current.some((t) => t.id === tab.id)) {
    writeActiveTab(tab.id);
    return;
  }
  writeOpenTabs([...current, tab]);
  writeActiveTab(tab.id);
};

/**
 * Pure reorder helper used by both storage and in-memory state code paths.
 *
 * `toIndex` is the destination position in the RESULTING array (matches
 * `arrayMove` semantics), not a visual insertion index. Returns the same
 * reference when the move would be a noop (unknown id, in-place move) so
 * callers can bail out cheaply.
 */
export const applyTabMove = <T extends { id: string }>(
  list: T[],
  fromId: string,
  toIndex: number,
): T[] => {
  const fromIndex = list.findIndex((t) => t.id === fromId);
  if (fromIndex === -1) return list;
  const clamped = Math.max(0, Math.min(toIndex, list.length - 1));
  if (fromIndex === clamped) return list;
  const next = list.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(clamped, 0, moved);
  return next;
};

/**
 * Move an open tab to a new position and persist. `toIndex` is the destination
 * index in the resulting order. Silently noops on unknown id / same position
 * (no write). Callers that manage React state should still call `writeOpenTabs`
 * via their own effect — this helper exists as the pure storage-side twin.
 */
export const moveTabInStorage = (fromId: string, toIndex: number): void => {
  const current = readOpenTabs();
  const next = applyTabMove(current, fromId, toIndex);
  if (next === current) return;
  writeOpenTabs(next);
};

/**
 * Replace the currently active tab (if any) with the given drawing. If no
 * active tab is set, behaves like appendTabToStorage.
 */
export const replaceActiveTabInStorage = (tab: StoredTab): void => {
  const current = readOpenTabs();
  const active = readActiveTab();
  if (!active || !current.some((t) => t.id === active)) {
    appendTabToStorage(tab);
    return;
  }
  if (current.some((t) => t.id === tab.id)) {
    writeActiveTab(tab.id);
    return;
  }
  const next = current.map((t) => (t.id === active ? tab : t));
  writeOpenTabs(next);
  writeActiveTab(tab.id);
};

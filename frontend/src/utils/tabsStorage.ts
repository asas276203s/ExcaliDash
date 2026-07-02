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

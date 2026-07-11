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

/**
 * Base (legacy, pre-namespacing) storage keys. The live keys are now scoped
 * per signed-in user — see {@link scopedKey}. These bases are still exported
 * because they double as the migration source (the old shared workspace).
 */
export const OPEN_TABS_KEY = "excalidash.open-tabs";
export const ACTIVE_TAB_KEY = "excalidash.active-tab";
export const CLOSED_TABS_KEY = "excalidash.closed-tabs";

const MAX_CLOSED_HISTORY = 20;

// Auth state is persisted by AuthContext under these localStorage keys. We read
// them (lazily, at call time — never cache) to derive the storage scope. The
// strings are duplicated here rather than imported to keep tabsStorage free of
// any React/context dependency.
const SCOPE_USER_KEY = "excalidash-user";
const SCOPE_AUTH_ENABLED_KEY = "excalidash-auth-enabled";
/**
 * Scope used when authentication is disabled (single-user deployments have no
 * user object, yet the one operator still deserves a persistent workspace).
 */
const LOCAL_SCOPE = "__local__";

/**
 * Resolve the identity that OWNS the tab workspace right now.
 *
 * - A signed-in user → their user id (workspaces are private per account, so a
 *   second account signing in on the same browser can never see or clobber the
 *   first's open tabs — same privacy principle as the `/shared` link-leak fix).
 * - Auth disabled → a fixed local scope (single-user mode still persists).
 * - Anonymous / signed-out with auth enabled → `null`: read nothing, write
 *   nothing. A logged-out visitor (or a `/shared/:id` viewer) must not be able
 *   to read or overwrite any account's workspace.
 *
 * Read lazily every call so there is no ordering dependency on when auth state
 * lands — hydration that races a fresh login always sees the current owner.
 */
export const resolveTabsScopeId = (): string | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SCOPE_USER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { id?: unknown } | null;
      const id = parsed?.id;
      if (typeof id === "string" && id.length > 0) return id;
    }
  } catch {
    /* fall through to the auth-disabled / anonymous checks */
  }
  if (window.localStorage.getItem(SCOPE_AUTH_ENABLED_KEY) === "false") {
    return LOCAL_SCOPE;
  }
  return null;
};

/**
 * Compute the live, per-user storage key for a base key, or `null` when there
 * is no owner (anonymous). On the first access for a given owner, a pre-existing
 * legacy (un-namespaced) value is MOVED under the owner's key — a one-time,
 * lossless migration. It is a move (copy + delete) rather than a copy so the old
 * shared value can't subsequently leak to a different account on the browser.
 */
const scopedKey = (base: string): string | null => {
  const scope = resolveTabsScopeId();
  if (!scope) return null;
  const key = `${base}:${scope}`;
  try {
    if (window.localStorage.getItem(key) === null) {
      const legacy = window.localStorage.getItem(base);
      if (legacy !== null) {
        window.localStorage.setItem(key, legacy);
        window.localStorage.removeItem(base);
      }
    }
  } catch {
    /* storage may be unavailable (private mode / quota) — ignore */
  }
  return key;
};

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
  const key = scopedKey(OPEN_TABS_KEY);
  if (!key) return [];
  const raw = window.localStorage.getItem(key);
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
  const key = scopedKey(OPEN_TABS_KEY);
  if (!key) return;
  const clean = dedupeById(tabs);
  window.localStorage.setItem(key, JSON.stringify(clean));
};

export const readActiveTab = (): string | null => {
  if (typeof window === "undefined") return null;
  const key = scopedKey(ACTIVE_TAB_KEY);
  if (!key) return null;
  const value = window.localStorage.getItem(key);
  return isValidId(value) ? value : null;
};

export const writeActiveTab = (id: string | null): void => {
  if (typeof window === "undefined") return;
  const key = scopedKey(ACTIVE_TAB_KEY);
  if (!key) return;
  if (isValidId(id)) {
    window.localStorage.setItem(key, id);
  } else {
    window.localStorage.removeItem(key);
  }
};

export const readClosedTabs = (): StoredTab[] => {
  if (typeof window === "undefined") return [];
  const key = scopedKey(CLOSED_TABS_KEY);
  if (!key) return [];
  const raw = window.localStorage.getItem(key);
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
  const key = scopedKey(CLOSED_TABS_KEY);
  if (!key) return;
  const trimmed = tabs.slice(0, MAX_CLOSED_HISTORY);
  window.localStorage.setItem(key, JSON.stringify(trimmed));
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

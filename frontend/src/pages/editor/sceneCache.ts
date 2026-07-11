/**
 * In-memory, per-drawing scene cache (stale-while-revalidate).
 *
 * Why this exists
 * ---------------
 * `Editor` remounts on every tab switch (`key={drawingId}` — see the header
 * comment in `Editor.tsx`). Remounting is what guarantees the previous tab's
 * in-flight scene state can never bleed into the next tab. The cost of that
 * correctness guarantee is that switching to a drawing you viewed seconds ago
 * pays a *full* `getDrawing` network round-trip again while a "Loading
 * drawing..." spinner covers the canvas. Profiling (300-element drawings)
 * showed the remount + Excalidraw init floor is a constant ~90ms, but the
 * serial scene re-fetch adds ~390ms at a 120ms RTT — so on a real network the
 * switch *feels* like it hangs.
 *
 * This module keeps the last few loaded scenes in memory so a switch back can
 * render the cached scene INSTANTLY (no spinner), then quietly revalidates
 * against the server in the background and applies any newer version.
 *
 * Correctness invariants (these are the whole point — do not weaken them)
 * ----------------------------------------------------------------------
 * 1. Entries are STRICTLY keyed by drawingId. A read for drawing B can only
 *    ever return data written for drawing B. There is no code path that copies
 *    one drawing's scene into another's slot, so the be3bd60 "tab 1 leaks into
 *    tab 2" class of bug cannot be reintroduced through this cache.
 * 2. Writes only ever come from that drawing's own server fetch or from a
 *    snapshot of that same drawing's live editor on unmount.
 * 3. The scene loader's load-token guard still owns race safety: a background
 *    revalidate that resolves after the user has moved on is discarded by the
 *    token check, exactly as a cold fetch would be.
 * 4. The cache is invalidated on logout and when a drawing is deleted so a
 *    stale scene can never resurrect after the underlying data is gone.
 */

export interface CachedScene {
  /** Server drawing version at the time this entry was written (or null). */
  version: number | null;
  drawingName: string;
  accessLevel: "none" | "view" | "edit" | "owner";
  /** Normalized elements — safe to hand straight to Excalidraw. */
  elements: readonly any[];
  /** Persisted app state WITHOUT a live `collaborators` map. */
  appState: any;
  files: Record<string, any>;
  libraryItems: any[];
  cachedAt: number;
}

/** How many drawings to keep hot. Small on purpose: this is a switch-back
 * accelerator, not a full offline store. */
export const SCENE_CACHE_MAX = 5;

// Module-level LRU. Map preserves insertion order, which we exploit for
// eviction: on every write we delete-then-set so the freshest key is last, and
// evict from the front (oldest) when over capacity.
const cache = new Map<string, CachedScene>();

export const getCachedScene = (drawingId: string | undefined | null): CachedScene | null => {
  if (!drawingId) return null;
  const entry = cache.get(drawingId);
  if (!entry) return null;
  // Refresh LRU recency on read.
  cache.delete(drawingId);
  cache.set(drawingId, entry);
  return entry;
};

export const setCachedScene = (drawingId: string | undefined | null, scene: CachedScene): void => {
  if (!drawingId) return;
  if (cache.has(drawingId)) cache.delete(drawingId);
  cache.set(drawingId, scene);
  while (cache.size > SCENE_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
};

/**
 * Update only the mutable scene fields of an existing entry from the live
 * editor (used to snapshot unsaved edits on unmount). Deliberately a no-op if
 * there is no existing entry: we never fabricate name/accessLevel/library from
 * a bare unmount, we only refresh an entry a real fetch already populated.
 */
export const updateCachedSceneData = (
  drawingId: string | undefined | null,
  data: { version: number | null; elements: readonly any[]; appState: any; files: Record<string, any> },
): void => {
  if (!drawingId) return;
  const entry = cache.get(drawingId);
  if (!entry) return;
  const next: CachedScene = {
    ...entry,
    version: data.version,
    elements: data.elements,
    appState: data.appState,
    files: data.files,
    cachedAt: Date.now(),
  };
  cache.delete(drawingId);
  cache.set(drawingId, next);
};

export const deleteCachedScene = (drawingId: string | undefined | null): void => {
  if (!drawingId) return;
  cache.delete(drawingId);
};

export const clearSceneCache = (): void => {
  cache.clear();
};

/** Test-only helper. */
export const _sceneCacheSize = (): number => cache.size;

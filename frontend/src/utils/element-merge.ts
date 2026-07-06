import { reconcileElements } from "./sync";

/**
 * Pure merge for two lists of Excalidraw elements.
 *
 * Rules — mirror `reconcileElements` so the socket path
 * (`useEditorCollaboration`) and the 409 retry path
 * (`useEditorPersistence`) behave identically:
 *
 *   - Element present only in `local` → kept as-is.
 *   - Element present only in `remote` → adopted.
 *   - Element present in both → higher `version` wins, then
 *     `updated`, then `versionNonce`, then content signature.
 *
 * The result preserves local's element order for elements that also exist
 * remotely, then appends any remote-only elements at the end. Callers that
 * need remote ordering should follow this with `applyElementOrder`.
 */
export const mergeElements = (
  local: readonly any[],
  remote: readonly any[],
): any[] => reconcileElements(local, remote);

/**
 * Count how many element IDs differ between `local` and `remote`.
 *
 * "Differ" = present on one side only, or present on both but with a
 * different `version`. The count is used to describe the auto-merge in a
 * toast ("MCP updated N element(s)"). It is a UX hint, not a diff tool —
 * keep it O(n).
 */
export const diffCount = (
  local: readonly any[],
  remote: readonly any[],
): number => {
  const localMap = new Map<string, any>();
  for (const el of local) {
    if (el && typeof el.id === "string") localMap.set(el.id, el);
  }
  let count = 0;
  const seen = new Set<string>();
  for (const el of remote) {
    if (!el || typeof el.id !== "string") continue;
    seen.add(el.id);
    const localEl = localMap.get(el.id);
    if (!localEl) {
      count += 1;
      continue;
    }
    const localVersion = typeof localEl.version === "number" ? localEl.version : 0;
    const remoteVersion = typeof el.version === "number" ? el.version : 0;
    if (localVersion !== remoteVersion) count += 1;
  }
  for (const el of local) {
    if (!el || typeof el.id !== "string") continue;
    if (!seen.has(el.id)) count += 1;
  }
  return count;
};

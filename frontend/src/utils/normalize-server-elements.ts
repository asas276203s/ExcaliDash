/**
 * Normalize raw elements coming from the server (drawing GET, socket-triggered
 * fetch-and-merge, 409-merge fetch) into fully-formed Excalidraw elements
 * BEFORE they are ever handed to `updateScene`.
 *
 * Why this exists (the 白屏 root cause):
 * MCP writes (`update_drawing` / `patch_drawing`) and hand-authored payloads
 * can persist elements that omit fields Excalidraw's renderer treats as
 * mandatory — most importantly `groupIds`. When such an element reaches
 * Excalidraw's internal render/reconcile loop it evaluates
 * `element.groupIds.length` and throws
 * `"undefined is not an object (evaluating 'b.groupIds.length')"`, which the
 * ErrorBoundary catches (and, before the ErrorBoundary existed, showed as a
 * blank canvas / 白屏). Two different users hit this simultaneously on the same
 * MCP-updated drawing.
 *
 * We intentionally DO NOT import Excalidraw's own `restoreElements` here:
 * `@excalidraw/excalidraw`'s barrel entry executes browser-only UI module code
 * at import time and cannot be loaded in the jsdom unit-test environment (see
 * the same constraint documented in `pages/editor/shared.ts`). Instead we
 * backfill the exact base-element fields Excalidraw's renderer/reconciler
 * assume are present. This is a pure function — no DOM, no heavy deps — so it
 * runs identically in the browser, in unit tests, and (mirrored) on the
 * backend.
 *
 * Immutability: never mutates the input element; returns a new object only when
 * a field is actually missing.
 */

const randomInteger = (): number => Math.floor(Math.random() * 2 ** 31);

/**
 * Base fields present on EVERY Excalidraw element. Missing any of these can
 * crash the renderer/reconciler; `groupIds` is the specific one seen in the
 * production trace. Values mirror Excalidraw's own element defaults.
 */
const applyBaseDefaults = (el: Record<string, any>): Record<string, any> => {
  const patched: Record<string, any> = el;
  let next: Record<string, any> | null = null;
  const ensure = (key: string, fallback: () => unknown) => {
    if (patched[key] === undefined) {
      if (!next) next = { ...patched };
      next[key] = fallback();
    }
  };

  ensure("groupIds", () => []);
  ensure("boundElements", () => null);
  ensure("frameId", () => null);
  ensure("roundness", () => null);
  ensure("angle", () => 0);
  ensure("x", () => 0);
  ensure("y", () => 0);
  ensure("width", () => 0);
  ensure("height", () => 0);
  ensure("strokeColor", () => "#1e1e1e");
  ensure("backgroundColor", () => "transparent");
  ensure("fillStyle", () => "solid");
  ensure("strokeWidth", () => 2);
  ensure("strokeStyle", () => "solid");
  ensure("roughness", () => 1);
  ensure("opacity", () => 100);
  ensure("seed", () => randomInteger());
  ensure("version", () => 1);
  ensure("versionNonce", () => randomInteger());
  ensure("isDeleted", () => false);
  ensure("updated", () => Date.now());
  ensure("link", () => null);
  ensure("locked", () => false);

  return next ?? patched;
};

/** True for objects that at least look like an element (have an `id`). */
const isElementLike = (value: unknown): value is Record<string, any> =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof (value as { id?: unknown }).id === "string";

export const normalizeServerElements = (
  elements: readonly unknown[] | null | undefined,
): any[] => {
  if (!Array.isArray(elements) || elements.length === 0) return [];
  const out: any[] = [];
  for (const el of elements) {
    // Drop entries that can't possibly be valid elements rather than letting
    // them reach the renderer.
    if (!isElementLike(el)) continue;
    out.push(applyBaseDefaults(el));
  }
  return out;
};

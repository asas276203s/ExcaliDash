/**
 * Backend defence-in-depth normalizer for Excalidraw elements.
 *
 * Mirrors `frontend/src/utils/normalize-server-elements.ts`. MCP writes
 * (`update_drawing` / `patch_drawing`) and hand-authored imports can persist
 * elements that omit fields Excalidraw's renderer treats as mandatory — most
 * importantly `groupIds`. A client rendering such an element crashes on
 * `element.groupIds.length` ("undefined is not an object"), which surfaced as
 * a blank canvas / 白屏 for two users on the same MCP-updated drawing.
 *
 * The frontend now normalizes on every read path, but we ALSO normalize here so
 * that:
 *   1. The GET response is clean even for older clients that don't normalize.
 *   2. Data written via PUT/POST lands in the DB already well-formed.
 *
 * This is intentionally minimal and pure: it only backfills missing base
 * fields (never overwrites present ones) and never mutates its input.
 */

const randomInteger = (): number => Math.floor(Math.random() * 2 ** 31);

type ElementRecord = Record<string, unknown>;

const isElementLike = (value: unknown): value is ElementRecord =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof (value as { id?: unknown }).id === "string";

const applyBaseDefaults = (el: ElementRecord): ElementRecord => {
  let next: ElementRecord | null = null;
  const ensure = (key: string, fallback: () => unknown) => {
    if (el[key] === undefined) {
      if (!next) next = { ...el };
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

  return next ?? el;
};

/**
 * Normalize an array of raw elements. Non-array input returns `[]`; entries
 * that don't look like elements (null, missing string `id`) are dropped.
 */
export const normalizeDrawingElements = (elements: unknown): unknown[] => {
  if (!Array.isArray(elements) || elements.length === 0) return [];
  const out: unknown[] = [];
  for (const el of elements) {
    if (!isElementLike(el)) continue;
    out.push(applyBaseDefaults(el));
  }
  return out;
};

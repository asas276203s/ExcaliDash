/**
 * Pure helpers for the custom floating font-size control.
 *
 * This module deliberately imports NOTHING from `@excalidraw/excalidraw`
 * so it stays cheap to unit-test under jsdom (same reasoning as the
 * `CAPTURE_UPDATE_NEVER` note in `shared.ts`). All logic that needs the
 * excalidraw UI bundle (restoreElements / newElementWith / updateScene)
 * lives in the `.tsx` component instead.
 */

export const FONT_SIZE_MIN = 4;
export const FONT_SIZE_MAX = 999;
/** Excalidraw's Medium preset — used as a fallback when a value is missing. */
export const DEFAULT_FONT_SIZE = 20;

/** Round + clamp an arbitrary numeric input into the allowed px range. */
export const clampFontSize = (value: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_FONT_SIZE;
  const rounded = Math.round(value);
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, rounded));
};

/** Step `current` by `delta`, clamped into range. Used by arrow-key nudging. */
export const nextFontSize = (current: number, delta: number): number =>
  clampFontSize((Number.isFinite(current) ? current : DEFAULT_FONT_SIZE) + delta);

const isTextElement = (el: any): boolean =>
  !!el && el.type === "text" && !el.isDeleted;

const isSelected = (
  id: unknown,
  selectedElementIds: Record<string, boolean> | undefined | null,
): boolean =>
  typeof id === "string" && !!selectedElementIds && selectedElementIds[id] === true;

/**
 * Resolve the text elements a font-size change should apply to, given the
 * current selection. Handles two cases:
 *
 *   1. A standalone text element is selected directly.
 *   2. A container (rectangle, ellipse, …) with a bound text label is
 *      selected — the bound text element is targeted even though its own id
 *      is not in `selectedElementIds`.
 *
 * The returned list is de-duplicated by id and preserves scene order.
 */
export const collectTargetTextElements = (
  elements: readonly any[] | null | undefined,
  selectedElementIds: Record<string, boolean> | undefined | null,
): any[] => {
  if (!Array.isArray(elements) || elements.length === 0) return [];

  const byId = new Map<string, any>();
  for (const el of elements) {
    if (el && typeof el.id === "string") byId.set(el.id, el);
  }

  const result: any[] = [];
  const seen = new Set<string>();
  const pushText = (el: any) => {
    if (isTextElement(el) && !seen.has(el.id)) {
      seen.add(el.id);
      result.push(el);
    }
  };

  for (const el of elements) {
    if (!el || !isSelected(el.id, selectedElementIds)) continue;

    if (isTextElement(el)) {
      pushText(el);
      continue;
    }

    // Container-bound text: change the label's font size.
    if (Array.isArray(el.boundElements)) {
      for (const bound of el.boundElements) {
        if (bound && bound.type === "text" && typeof bound.id === "string") {
          const boundEl = byId.get(bound.id);
          if (boundEl) pushText(boundEl);
        }
      }
    }
  }

  return result;
};

/**
 * Reduce the target text elements to a single display value:
 *   - `null`   → nothing to show (no text targets)
 *   - `"mixed"` → targets have differing font sizes
 *   - number   → the shared font size (px)
 */
export const computeDisplayFontSize = (
  targets: readonly any[] | null | undefined,
): number | "mixed" | null => {
  if (!targets || targets.length === 0) return null;
  let size: number | null = null;
  for (const el of targets) {
    const fs =
      typeof el?.fontSize === "number" && Number.isFinite(el.fontSize)
        ? Math.round(el.fontSize)
        : DEFAULT_FONT_SIZE;
    if (size === null) size = fs;
    else if (size !== fs) return "mixed";
  }
  return size;
};

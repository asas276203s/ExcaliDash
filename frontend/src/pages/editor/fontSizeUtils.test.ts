import { describe, it, expect } from "vitest";
import {
  clampFontSize,
  nextFontSize,
  collectTargetTextElements,
  computeDisplayFontSize,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  DEFAULT_FONT_SIZE,
} from "./fontSizeUtils";

const text = (id: string, fontSize?: number, extra: Record<string, any> = {}) => ({
  id,
  type: "text",
  fontSize,
  ...extra,
});

const sel = (...ids: string[]): Record<string, boolean> =>
  Object.fromEntries(ids.map((id) => [id, true]));

describe("clampFontSize", () => {
  it("rounds and clamps into range", () => {
    expect(clampFontSize(20.4)).toBe(20);
    expect(clampFontSize(20.6)).toBe(21);
    expect(clampFontSize(0)).toBe(FONT_SIZE_MIN);
    expect(clampFontSize(99999)).toBe(FONT_SIZE_MAX);
  });
  it("falls back to the default on non-finite input", () => {
    expect(clampFontSize(NaN)).toBe(DEFAULT_FONT_SIZE);
    expect(clampFontSize(Infinity)).toBe(DEFAULT_FONT_SIZE);
  });
});

describe("nextFontSize", () => {
  it("steps and clamps", () => {
    expect(nextFontSize(20, 1)).toBe(21);
    expect(nextFontSize(20, -4)).toBe(16);
    expect(nextFontSize(FONT_SIZE_MIN, -1)).toBe(FONT_SIZE_MIN);
    expect(nextFontSize(FONT_SIZE_MAX, 4)).toBe(FONT_SIZE_MAX);
  });
  it("uses default base when current is invalid", () => {
    expect(nextFontSize(NaN, 1)).toBe(DEFAULT_FONT_SIZE + 1);
  });
});

describe("collectTargetTextElements", () => {
  it("returns empty when nothing selected", () => {
    expect(collectTargetTextElements([text("a", 20)], {})).toEqual([]);
  });

  it("targets a directly-selected text element", () => {
    const els = [text("a", 20), text("b", 28)];
    expect(collectTargetTextElements(els, sel("a")).map((e) => e.id)).toEqual(["a"]);
  });

  it("targets multiple selected text elements", () => {
    const els = [text("a", 20), text("b", 28), text("c", 16)];
    expect(collectTargetTextElements(els, sel("a", "c")).map((e) => e.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("resolves bound text of a selected container", () => {
    const container = {
      id: "rect",
      type: "rectangle",
      boundElements: [{ id: "label", type: "text" }],
    };
    const label = text("label", 24, { containerId: "rect" });
    const els = [container, label];
    expect(collectTargetTextElements(els, sel("rect")).map((e) => e.id)).toEqual([
      "label",
    ]);
  });

  it("ignores non-text elements with no bound text", () => {
    const els = [{ id: "rect", type: "rectangle" }, text("a", 20)];
    expect(collectTargetTextElements(els, sel("rect")).map((e) => e.id)).toEqual([]);
  });

  it("skips deleted text elements", () => {
    const els = [text("a", 20, { isDeleted: true })];
    expect(collectTargetTextElements(els, sel("a"))).toEqual([]);
  });

  it("de-duplicates when both container and its bound text are selected", () => {
    const container = {
      id: "rect",
      type: "rectangle",
      boundElements: [{ id: "label", type: "text" }],
    };
    const label = text("label", 24, { containerId: "rect" });
    const els = [container, label];
    expect(
      collectTargetTextElements(els, sel("rect", "label")).map((e) => e.id),
    ).toEqual(["label"]);
  });
});

describe("computeDisplayFontSize", () => {
  it("returns null for no targets", () => {
    expect(computeDisplayFontSize([])).toBeNull();
  });
  it("returns the shared size", () => {
    expect(computeDisplayFontSize([text("a", 28), text("b", 28)])).toBe(28);
  });
  it("returns 'mixed' for differing sizes", () => {
    expect(computeDisplayFontSize([text("a", 20), text("b", 28)])).toBe("mixed");
  });
  it("defaults missing fontSize to the medium preset", () => {
    expect(computeDisplayFontSize([text("a")])).toBe(DEFAULT_FONT_SIZE);
  });
});

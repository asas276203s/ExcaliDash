import { describe, expect, it } from "vitest";
import { normalizeDrawingElements } from "./normalizeElements";

describe("normalizeDrawingElements", () => {
  const mcpStyleElement = {
    id: "mcp-rect-1",
    type: "rectangle",
    x: 10,
    y: 20,
    width: 100,
    height: 50,
  };

  it("backfills groupIds (the 白屏 crash field) as an array", () => {
    const [el] = normalizeDrawingElements([mcpStyleElement]) as any[];
    expect(Array.isArray(el.groupIds)).toBe(true);
    expect(el.groupIds).toEqual([]);
    // The exact expression that crashed the renderer must be safe now.
    expect(() => el.groupIds.length).not.toThrow();
  });

  it("backfills other required base fields", () => {
    const [el] = normalizeDrawingElements([mcpStyleElement]) as any[];
    expect(el.boundElements).toBe(null);
    expect(el.frameId).toBe(null);
    expect(el.roundness).toBe(null);
    expect(typeof el.versionNonce).toBe("number");
    expect(el.isDeleted).toBe(false);
  });

  it("preserves existing fields and identity, does not mutate input", () => {
    const input = { ...mcpStyleElement, groupIds: ["g1"] };
    const [el] = normalizeDrawingElements([input]) as any[];
    expect(el.id).toBe("mcp-rect-1");
    expect(el.groupIds).toEqual(["g1"]);
    // input untouched
    expect((input as any).boundElements).toBeUndefined();
  });

  it("drops non-element entries and handles non-array input", () => {
    expect(normalizeDrawingElements(null)).toEqual([]);
    expect(normalizeDrawingElements(undefined)).toEqual([]);
    expect(normalizeDrawingElements("nope")).toEqual([]);
    const res = normalizeDrawingElements([null, { type: "rectangle" }, mcpStyleElement]);
    expect(res).toHaveLength(1);
  });
});

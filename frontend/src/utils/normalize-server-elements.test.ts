import { describe, expect, it } from "vitest";
import { normalizeServerElements } from "./normalize-server-elements";

/**
 * Regression for the production 白屏 crash:
 *   "undefined is not an object (evaluating 'b.groupIds.length')"
 * Two different users crashed simultaneously rendering the same MCP-updated
 * drawing whose elements were missing `groupIds`.
 */
describe("normalizeServerElements", () => {
  // A minimally-authored element as an MCP write can persist it: no groupIds,
  // no boundElements, no versionNonce — exactly the shape that crashed the
  // renderer.
  const mcpStyleElement = {
    id: "mcp-rect-1",
    type: "rectangle",
    x: 10,
    y: 20,
    width: 100,
    height: 50,
  } as const;

  // Simulates the exact line inside Excalidraw's render/reconcile loop that
  // blew up in production (`b.groupIds.length`).
  const renderTouch = (el: any): number => el.groupIds.length;

  it("PROOF the raw (un-normalized) element crashes the render touch", () => {
    // If this ever stops throwing, the regression test below no longer proves
    // anything — this asserts the test actually reproduces the bug.
    expect(() => renderTouch(mcpStyleElement)).toThrow();
  });

  it("backfills groupIds so the render touch no longer crashes", () => {
    const [normalized] = normalizeServerElements([mcpStyleElement]);
    expect(Array.isArray(normalized.groupIds)).toBe(true);
    expect(() => renderTouch(normalized)).not.toThrow();
    expect(renderTouch(normalized)).toBe(0);
  });

  it("backfills other renderer-required base fields", () => {
    const [normalized] = normalizeServerElements([mcpStyleElement]);
    expect(normalized).toHaveProperty("boundElements", null);
    expect(normalized).toHaveProperty("frameId", null);
    expect(normalized).toHaveProperty("roundness", null);
    expect(typeof normalized.versionNonce).toBe("number");
    expect(typeof normalized.seed).toBe("number");
    expect(normalized.isDeleted).toBe(false);
    expect(normalized.angle).toBe(0);
  });

  it("preserves original identity, geometry and existing fields", () => {
    const withGroups = {
      ...mcpStyleElement,
      groupIds: ["g1"],
      strokeColor: "#ff0000",
    };
    const [normalized] = normalizeServerElements([withGroups]);
    expect(normalized.id).toBe("mcp-rect-1");
    expect(normalized.type).toBe("rectangle");
    expect(normalized.x).toBe(10);
    expect(normalized.width).toBe(100);
    // Existing fields must NOT be clobbered by defaults.
    expect(normalized.groupIds).toEqual(["g1"]);
    expect(normalized.strokeColor).toBe("#ff0000");
  });

  it("does not mutate the input element", () => {
    const input = { ...mcpStyleElement };
    normalizeServerElements([input]);
    expect(input).not.toHaveProperty("groupIds");
  });

  it("drops non-element entries (null / no id)", () => {
    const result = normalizeServerElements([
      null,
      { type: "rectangle" }, // no id
      mcpStyleElement,
    ] as any);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("mcp-rect-1");
  });

  it("returns [] for empty / nullish input", () => {
    expect(normalizeServerElements(null)).toEqual([]);
    expect(normalizeServerElements(undefined)).toEqual([]);
    expect(normalizeServerElements([])).toEqual([]);
  });
});

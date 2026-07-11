import { describe, it, expect } from "vitest";
import { stripPreviewBackground } from "./previewSvg";

describe("stripPreviewBackground", () => {
  it("transparentises a full-canvas white background rect", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60" width="100" height="60">' +
      '<rect x="0" y="0" width="100" height="60" fill="#ffffff"></rect>' +
      '<path d="M10 10 L20 20" stroke="#000"></path></svg>';
    const out = stripPreviewBackground(svg)!;
    expect(out).toContain('fill="transparent"');
    expect(out).not.toContain('fill="#ffffff"');
    // strokes are untouched
    expect(out).toContain("<path");
  });

  it("matches white in named / short-hex form too", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20">' +
      '<rect x="0" y="0" width="20" height="20" fill="white"></rect></svg>';
    const out = stripPreviewBackground(svg)!;
    expect(out).toContain('fill="transparent"');
  });

  it("leaves non-background rects (offset or non-white) alone", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60" width="100" height="60">' +
      '<rect x="5" y="5" width="10" height="10" fill="#ffffff"></rect>' +
      '<rect x="0" y="0" width="100" height="60" fill="#ff0000"></rect></svg>';
    const out = stripPreviewBackground(svg)!;
    expect(out).toContain('fill="#ffffff"'); // offset white rect kept
    expect(out).toContain('fill="#ff0000"'); // colored bg kept
    expect(out).not.toContain('fill="transparent"');
  });

  it("passes through empty / non-svg input", () => {
    expect(stripPreviewBackground("")).toBe("");
    expect(stripPreviewBackground(null)).toBeNull();
    expect(stripPreviewBackground(undefined)).toBeNull();
  });
});

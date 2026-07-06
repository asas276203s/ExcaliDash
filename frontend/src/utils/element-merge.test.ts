import { describe, expect, it } from "vitest";
import { diffCount, mergeElements } from "./element-merge";

const el = (
  id: string,
  version = 1,
  extras: Record<string, unknown> = {},
) => ({
  id,
  version,
  versionNonce: version * 100,
  updated: version,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  ...extras,
});

describe("mergeElements", () => {
  it("returns local when remote is empty", () => {
    const local = [el("a"), el("b")];
    const merged = mergeElements(local, []);
    expect(merged.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });

  it("adopts remote-only elements", () => {
    const merged = mergeElements([el("a")], [el("b")]);
    expect(merged.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });

  it("keeps local element when local version is higher", () => {
    const local = [el("a", 5)];
    const remote = [el("a", 3)];
    const merged = mergeElements(local, remote);
    expect(merged).toHaveLength(1);
    expect(merged[0].version).toBe(5);
  });

  it("adopts remote element when remote version is higher", () => {
    const local = [el("a", 3)];
    const remote = [el("a", 5)];
    const merged = mergeElements(local, remote);
    expect(merged).toHaveLength(1);
    expect(merged[0].version).toBe(5);
  });

  it("handles concurrent edits: local rect + remote circle", () => {
    const local = [el("a", 2, { type: "rectangle" })];
    const remote = [el("b", 2, { type: "ellipse" })];
    const merged = mergeElements(local, remote);
    expect(merged).toHaveLength(2);
    expect(merged.find((e) => e.id === "a")?.type).toBe("rectangle");
    expect(merged.find((e) => e.id === "b")?.type).toBe("ellipse");
  });

  it("does not lose a deletion signaled by isDeleted on remote", () => {
    const local = [el("a", 1)];
    const remote = [el("a", 2, { isDeleted: true })];
    const merged = mergeElements(local, remote);
    expect(merged).toHaveLength(1);
    expect(merged[0].isDeleted).toBe(true);
  });

  it("is a no-op when both sides are equal", () => {
    const local = [el("a"), el("b")];
    const remote = [el("a"), el("b")];
    const merged = mergeElements(local, remote);
    expect(merged.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });
});

describe("diffCount", () => {
  it("returns 0 when identical", () => {
    expect(diffCount([el("a"), el("b")], [el("a"), el("b")])).toBe(0);
  });

  it("counts remote-only elements", () => {
    expect(diffCount([el("a")], [el("a"), el("b")])).toBe(1);
  });

  it("counts local-only elements", () => {
    expect(diffCount([el("a"), el("b")], [el("a")])).toBe(1);
  });

  it("counts version differences", () => {
    expect(diffCount([el("a", 1)], [el("a", 4)])).toBe(1);
  });

  it("counts a combined diff", () => {
    const local = [el("a", 1), el("b", 1)];
    const remote = [el("a", 5), el("c", 1)];
    // a differs (1 vs 5), b is local-only, c is remote-only → 3
    expect(diffCount(local, remote)).toBe(3);
  });

  it("ignores elements without an id", () => {
    const local = [{ version: 1 } as any, el("a")];
    const remote = [el("a")];
    expect(diffCount(local, remote)).toBe(0);
  });
});

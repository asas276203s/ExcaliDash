import { beforeEach, describe, expect, it } from "vitest";
import {
  SCENE_CACHE_MAX,
  clearSceneCache,
  deleteCachedScene,
  getCachedScene,
  setCachedScene,
  updateCachedSceneData,
  _sceneCacheSize,
  type CachedScene,
} from "./sceneCache";

const makeScene = (over: Partial<CachedScene> = {}): CachedScene => ({
  version: 1,
  drawingName: "Drawing",
  accessLevel: "owner",
  elements: [{ id: "a" }],
  appState: { viewBackgroundColor: "#fff" },
  files: {},
  libraryItems: [],
  cachedAt: Date.now(),
  ...over,
});

describe("sceneCache", () => {
  beforeEach(() => clearSceneCache());

  it("stores and retrieves strictly by drawing id", () => {
    setCachedScene("A", makeScene({ drawingName: "Alpha" }));
    setCachedScene("B", makeScene({ drawingName: "Beta" }));
    expect(getCachedScene("A")?.drawingName).toBe("Alpha");
    expect(getCachedScene("B")?.drawingName).toBe("Beta");
    // A read for one id never returns another id's data.
    expect(getCachedScene("C")).toBeNull();
  });

  it("returns null for empty / missing ids", () => {
    expect(getCachedScene(undefined)).toBeNull();
    expect(getCachedScene(null)).toBeNull();
    expect(getCachedScene("")).toBeNull();
  });

  it("evicts the least-recently-used entry beyond the cap", () => {
    for (let i = 0; i < SCENE_CACHE_MAX; i++) {
      setCachedScene(`d${i}`, makeScene());
    }
    expect(_sceneCacheSize()).toBe(SCENE_CACHE_MAX);
    // Touch d0 so it becomes most-recently-used.
    getCachedScene("d0");
    // Insert one more -> the now-oldest (d1) is evicted, d0 survives.
    setCachedScene("dNew", makeScene());
    expect(_sceneCacheSize()).toBe(SCENE_CACHE_MAX);
    expect(getCachedScene("d0")).not.toBeNull();
    expect(getCachedScene("d1")).toBeNull();
    expect(getCachedScene("dNew")).not.toBeNull();
  });

  it("updateCachedSceneData refreshes scene fields but preserves name/access/library", () => {
    setCachedScene("A", makeScene({ drawingName: "Alpha", accessLevel: "edit", libraryItems: [{ x: 1 }], version: 1 }));
    updateCachedSceneData("A", {
      version: 5,
      elements: [{ id: "a" }, { id: "b" }],
      appState: { viewBackgroundColor: "#000" },
      files: { f1: {} },
    });
    const e = getCachedScene("A")!;
    expect(e.version).toBe(5);
    expect(e.elements).toHaveLength(2);
    expect(e.files).toHaveProperty("f1");
    // Preserved metadata.
    expect(e.drawingName).toBe("Alpha");
    expect(e.accessLevel).toBe("edit");
    expect(e.libraryItems).toEqual([{ x: 1 }]);
  });

  it("updateCachedSceneData is a no-op when no entry exists (never fabricates)", () => {
    updateCachedSceneData("ghost", {
      version: 9,
      elements: [{ id: "z" }],
      appState: {},
      files: {},
    });
    expect(getCachedScene("ghost")).toBeNull();
  });

  it("deleteCachedScene removes a single entry", () => {
    setCachedScene("A", makeScene());
    setCachedScene("B", makeScene());
    deleteCachedScene("A");
    expect(getCachedScene("A")).toBeNull();
    expect(getCachedScene("B")).not.toBeNull();
  });

  it("clearSceneCache empties everything", () => {
    setCachedScene("A", makeScene());
    setCachedScene("B", makeScene());
    clearSceneCache();
    expect(_sceneCacheSize()).toBe(0);
  });
});

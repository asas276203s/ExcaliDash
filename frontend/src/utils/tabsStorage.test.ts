import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVE_TAB_KEY,
  CLOSED_TABS_KEY,
  OPEN_TABS_KEY,
  appendTabToStorage,
  buildTabsSearch,
  isTabsHiddenPath,
  mergeStoredTabsWithUrl,
  moveTabInStorage,
  parseTabsFromSearch,
  popClosedTab,
  pushClosedTab,
  readActiveTab,
  readClosedTabs,
  readOpenTabs,
  replaceActiveTabInStorage,
  stripTabsFromSearch,
  writeActiveTab,
  writeClosedTabs,
  writeOpenTabs,
} from "./tabsStorage";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("open tabs storage", () => {
  it("round-trips tabs list, dedupes duplicates", () => {
    writeOpenTabs([
      { id: "a", name: "Alpha" },
      { id: "b" },
      { id: "a", name: "Alpha again" },
    ]);
    expect(readOpenTabs()).toEqual([
      { id: "a", name: "Alpha" },
      { id: "b", name: undefined },
    ]);
  });

  it("returns [] when storage is corrupted", () => {
    window.localStorage.setItem(OPEN_TABS_KEY, "{not json");
    expect(readOpenTabs()).toEqual([]);
  });

  it("accepts legacy string-array format for forward compatibility", () => {
    window.localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(["x", "y"]));
    expect(readOpenTabs()).toEqual([
      { id: "x" },
      { id: "y" },
    ]);
  });

  it("rejects invalid ids", () => {
    writeOpenTabs([{ id: "" }, { id: "ok" }] as any);
    expect(readOpenTabs()).toEqual([{ id: "ok", name: undefined }]);
  });
});

describe("active tab storage", () => {
  it("round-trips active id", () => {
    writeActiveTab("abc");
    expect(readActiveTab()).toBe("abc");
  });

  it("clears when set to null", () => {
    writeActiveTab("abc");
    writeActiveTab(null);
    expect(readActiveTab()).toBeNull();
    expect(window.localStorage.getItem(ACTIVE_TAB_KEY)).toBeNull();
  });
});

describe("closed tabs stack", () => {
  it("pushes most recent to head and dedupes", () => {
    pushClosedTab({ id: "a" });
    pushClosedTab({ id: "b" });
    pushClosedTab({ id: "a" });
    expect(readClosedTabs()).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("popClosedTab returns head and shrinks stack", () => {
    writeClosedTabs([{ id: "a" }, { id: "b" }]);
    expect(popClosedTab()).toEqual({ id: "a" });
    expect(readClosedTabs()).toEqual([{ id: "b" }]);
  });

  it("popClosedTab returns null on empty stack", () => {
    expect(popClosedTab()).toBeNull();
  });

  it("trims to max 20 entries", () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({ id: `t${i}` }));
    writeClosedTabs(entries);
    expect(readClosedTabs()).toHaveLength(20);
  });

  it("ignores corrupted entries", () => {
    window.localStorage.setItem(CLOSED_TABS_KEY, JSON.stringify([null, { id: "ok" }, { name: "missing id" }]));
    expect(readClosedTabs()).toEqual([{ id: "ok", name: undefined }]);
  });
});

describe("URL search helpers", () => {
  it("parses tabs and active from search string", () => {
    expect(parseTabsFromSearch("?tabs=a,b,c&active=b")).toEqual({
      tabIds: ["a", "b", "c"],
      activeId: "b",
    });
  });

  it("returns nulls when params are missing", () => {
    expect(parseTabsFromSearch("")).toEqual({ tabIds: null, activeId: null });
    expect(parseTabsFromSearch("?other=x")).toEqual({
      tabIds: null,
      activeId: null,
    });
  });

  it("filters out empty ids from tabs param", () => {
    expect(parseTabsFromSearch("?tabs=a,,b&active=")).toEqual({
      tabIds: ["a", "b"],
      activeId: null,
    });
  });

  it("builds tabs+active search preserving other params", () => {
    const out = buildTabsSearch("?foo=1&tabs=x&active=x", ["a", "b"], "b");
    const params = new URLSearchParams(out.replace(/^\?/, ""));
    expect(params.get("foo")).toBe("1");
    expect(params.get("tabs")).toBe("a,b");
    expect(params.get("active")).toBe("b");
  });

  it("drops tabs/active when list empty", () => {
    const out = buildTabsSearch("?tabs=x&active=x", [], null);
    expect(out).toBe("");
  });
});

describe("shared-route tab hiding (privacy)", () => {
  it("treats /shared/:id as a hidden tab route", () => {
    expect(isTabsHiddenPath("/shared/abc123")).toBe(true);
    expect(isTabsHiddenPath("/shared")).toBe(true);
  });

  it("keeps the tab workspace on owner routes", () => {
    expect(isTabsHiddenPath("/editor/abc123")).toBe(false);
    expect(isTabsHiddenPath("/")).toBe(false);
    expect(isTabsHiddenPath("/collections")).toBe(false);
    expect(isTabsHiddenPath("/settings")).toBe(false);
  });

  it("hides tabs on auth routes", () => {
    expect(isTabsHiddenPath("/login")).toBe(true);
    expect(isTabsHiddenPath("/auth-setup")).toBe(true);
  });

  it("stripTabsFromSearch removes tabs+active but preserves other params", () => {
    // A leaked share URL would carry other drawings' ids in `tabs`.
    const cleaned = stripTabsFromSearch(
      "?tabs=target,secret-drawing-1,secret-drawing-2&active=target&addLibrary=x",
    );
    const params = new URLSearchParams(cleaned.replace(/^\?/, ""));
    expect(params.get("tabs")).toBeNull();
    expect(params.get("active")).toBeNull();
    expect(params.get("addLibrary")).toBe("x");
  });

  it("stripTabsFromSearch returns empty string when nothing else remains", () => {
    expect(stripTabsFromSearch("?tabs=a,b,c&active=a")).toBe("");
    expect(stripTabsFromSearch("")).toBe("");
  });
});

describe("higher-level helpers", () => {
  it("appendTabToStorage adds new tab and activates it", () => {
    writeOpenTabs([{ id: "a" }]);
    writeActiveTab("a");
    appendTabToStorage({ id: "b", name: "Beta" });
    expect(readOpenTabs()).toEqual([
      { id: "a", name: undefined },
      { id: "b", name: "Beta" },
    ]);
    expect(readActiveTab()).toBe("b");
  });

  it("appendTabToStorage just activates when id already present", () => {
    writeOpenTabs([{ id: "a" }, { id: "b" }]);
    writeActiveTab("a");
    appendTabToStorage({ id: "b" });
    expect(readOpenTabs()).toEqual([
      { id: "a", name: undefined },
      { id: "b", name: undefined },
    ]);
    expect(readActiveTab()).toBe("b");
  });

  it("replaceActiveTabInStorage swaps active in-place", () => {
    writeOpenTabs([{ id: "a" }, { id: "b" }, { id: "c" }]);
    writeActiveTab("b");
    replaceActiveTabInStorage({ id: "z", name: "Zed" });
    expect(readOpenTabs()).toEqual([
      { id: "a", name: undefined },
      { id: "z", name: "Zed" },
      { id: "c", name: undefined },
    ]);
    expect(readActiveTab()).toBe("z");
  });

  it("replaceActiveTabInStorage falls back to append when nothing active", () => {
    replaceActiveTabInStorage({ id: "x", name: "Ex" });
    expect(readOpenTabs()).toEqual([{ id: "x", name: "Ex" }]);
    expect(readActiveTab()).toBe("x");
  });

  it("replaceActiveTabInStorage just activates when id already open", () => {
    writeOpenTabs([{ id: "a" }, { id: "b" }]);
    writeActiveTab("a");
    replaceActiveTabInStorage({ id: "b" });
    expect(readOpenTabs()).toEqual([
      { id: "a", name: undefined },
      { id: "b", name: undefined },
    ]);
    expect(readActiveTab()).toBe("b");
  });
});

describe("moveTabInStorage", () => {
  it("moves a tab forward and persists new order", () => {
    writeOpenTabs([{ id: "a" }, { id: "b", name: "Beta" }, { id: "c" }, { id: "d" }]);
    moveTabInStorage("b", 2);
    expect(readOpenTabs()).toEqual([
      { id: "a", name: undefined },
      { id: "c", name: undefined },
      { id: "b", name: "Beta" },
      { id: "d", name: undefined },
    ]);
  });

  it("moves a tab backward and persists new order", () => {
    writeOpenTabs([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d", name: "Delta" }]);
    moveTabInStorage("d", 0);
    expect(readOpenTabs()).toEqual([
      { id: "d", name: "Delta" },
      { id: "a", name: undefined },
      { id: "b", name: undefined },
      { id: "c", name: undefined },
    ]);
  });

  it("is a noop when destination equals current index (no rewrite)", () => {
    writeOpenTabs([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const before = window.localStorage.getItem(OPEN_TABS_KEY);
    moveTabInStorage("b", 1);
    expect(window.localStorage.getItem(OPEN_TABS_KEY)).toBe(before);
    expect(readOpenTabs()).toEqual([
      { id: "a", name: undefined },
      { id: "b", name: undefined },
      { id: "c", name: undefined },
    ]);
  });

  it("is a noop when the id does not exist", () => {
    writeOpenTabs([{ id: "a" }, { id: "b" }]);
    const before = window.localStorage.getItem(OPEN_TABS_KEY);
    moveTabInStorage("missing", 0);
    expect(window.localStorage.getItem(OPEN_TABS_KEY)).toBe(before);
    expect(readOpenTabs()).toEqual([
      { id: "a", name: undefined },
      { id: "b", name: undefined },
    ]);
  });
});

describe("mergeStoredTabsWithUrl", () => {
  it("returns the stored workspace unchanged when the URL declares no tabs", () => {
    const stored = [{ id: "a", name: "A" }, { id: "b" }];
    expect(mergeStoredTabsWithUrl(stored, null)).toEqual([
      { id: "a", name: "A" },
      { id: "b", name: undefined },
    ]);
    expect(mergeStoredTabsWithUrl(stored, [])).toEqual([
      { id: "a", name: "A" },
      { id: "b", name: undefined },
    ]);
  });

  it("never shrinks the workspace: a partial URL keeps every stored tab", () => {
    const stored = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const merged = mergeStoredTabsWithUrl(stored, ["a"]);
    expect(merged.map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("honours URL order and reuses cached names, appending stored-only tabs", () => {
    const stored = [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
      { id: "c", name: "Gamma" },
    ];
    const merged = mergeStoredTabsWithUrl(stored, ["c", "a"]);
    expect(merged).toEqual([
      { id: "c", name: "Gamma" },
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ]);
  });

  it("adds URL-only tabs (a richer shared layout) after the URL ids", () => {
    const stored = [{ id: "a" }];
    const merged = mergeStoredTabsWithUrl(stored, ["a", "extra"]);
    expect(merged.map((t) => t.id)).toEqual(["a", "extra"]);
  });

  it("dedupes ids from both sources", () => {
    const merged = mergeStoredTabsWithUrl(
      [{ id: "a" }, { id: "a" }],
      ["a", "a", "b"],
    );
    expect(merged.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

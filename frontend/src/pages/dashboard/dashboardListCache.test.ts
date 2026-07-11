import { beforeEach, describe, expect, it } from "vitest";
import type { Collection, DrawingSummary } from "../../types";
import {
  DASHBOARD_LIST_CACHE_MAX,
  _dashboardListCacheSize,
  buildDashboardListKey,
  clearDashboardListCache,
  getCachedDashboardList,
  setCachedDashboardList,
} from "./dashboardListCache";

const drawing = (id: string): DrawingSummary =>
  ({
    id,
    name: id,
    collectionId: null,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    preview: null,
  }) as unknown as DrawingSummary;

const collection = (id: string): Collection =>
  ({ id, name: id, createdAt: 1 }) as unknown as Collection;

const entry = (id: string) => ({
  drawings: [drawing(id)],
  totalCount: 1,
  collections: [collection("c")],
  cachedAt: Date.now(),
});

describe("dashboardListCache", () => {
  beforeEach(() => {
    clearDashboardListCache();
  });

  it("distinguishes all / uncategorized / real-id views in the key", () => {
    const base = {
      search: "",
      sortField: "updatedAt",
      sortDirection: "desc",
      pageSize: 24,
    };
    const all = buildDashboardListKey({ view: undefined, ...base });
    const none = buildDashboardListKey({ view: null, ...base });
    const real = buildDashboardListKey({ view: "col-1", ...base });
    expect(new Set([all, none, real]).size).toBe(3);
  });

  it("keys vary by search / sort / pageSize", () => {
    const k = (o: Partial<Parameters<typeof buildDashboardListKey>[0]>) =>
      buildDashboardListKey({
        view: "col-1",
        search: "",
        sortField: "updatedAt",
        sortDirection: "desc",
        pageSize: 24,
        ...o,
      });
    const keys = new Set([
      k({}),
      k({ search: "foo" }),
      k({ sortField: "name" }),
      k({ sortDirection: "asc" }),
      k({ pageSize: 48 }),
    ]);
    expect(keys.size).toBe(5);
  });

  it("round-trips a stored entry by key", () => {
    setCachedDashboardList("k1", entry("d1"));
    expect(getCachedDashboardList("k1")?.drawings[0].id).toBe("d1");
    expect(getCachedDashboardList("missing")).toBeNull();
  });

  it("evicts the least-recently-used entry past capacity", () => {
    for (let i = 0; i < DASHBOARD_LIST_CACHE_MAX; i += 1) {
      setCachedDashboardList(`k${i}`, entry(`d${i}`));
    }
    expect(_dashboardListCacheSize()).toBe(DASHBOARD_LIST_CACHE_MAX);
    // Touch k0 so it becomes most-recently-used.
    getCachedDashboardList("k0");
    // Insert one more -> the now-oldest (k1) is evicted, k0 survives.
    setCachedDashboardList("kNew", entry("dNew"));
    expect(_dashboardListCacheSize()).toBe(DASHBOARD_LIST_CACHE_MAX);
    expect(getCachedDashboardList("k0")).not.toBeNull();
    expect(getCachedDashboardList("k1")).toBeNull();
    expect(getCachedDashboardList("kNew")).not.toBeNull();
  });

  it("clearDashboardListCache empties every entry", () => {
    setCachedDashboardList("k1", entry("d1"));
    setCachedDashboardList("k2", entry("d2"));
    clearDashboardListCache();
    expect(_dashboardListCacheSize()).toBe(0);
    expect(getCachedDashboardList("k1")).toBeNull();
  });
});

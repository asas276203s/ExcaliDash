import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRememberedDashboardView,
  rememberDashboardView,
} from "./lastDashboardView";

describe("lastDashboardView", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to the dashboard root when nothing was stored", () => {
    expect(getRememberedDashboardView()).toBe("/");
  });

  it("round-trips the collection the user was last viewing", () => {
    rememberDashboardView("/collections", "?id=abc123");
    expect(getRememberedDashboardView()).toBe("/collections?id=abc123");
  });

  it("ignores non-dashboard locations so the editor never restores itself", () => {
    rememberDashboardView("/collections", "?id=abc123");
    rememberDashboardView("/editor/d1", "");
    expect(getRememberedDashboardView()).toBe("/collections?id=abc123");
  });

  it("refuses a stored value that is not a known dashboard route", () => {
    window.localStorage.setItem(
      "excalidash:last-dashboard-view",
      "https://evil.example.com",
    );
    expect(getRememberedDashboardView()).toBe("/");
    window.localStorage.setItem("excalidash:last-dashboard-view", "/admin");
    expect(getRememberedDashboardView()).toBe("/");
  });

  it("survives storage being unavailable", () => {
    const getSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    expect(getRememberedDashboardView()).toBe("/");
    getSpy.mockRestore();
    const setSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    expect(() => rememberDashboardView("/", "")).not.toThrow();
    setSpy.mockRestore();
  });
});

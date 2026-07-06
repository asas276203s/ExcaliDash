import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_VERSION_SNOOZE_STORAGE_KEY,
  appVersionStore,
} from "./appVersion";

describe("appVersionStore", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    appVersionStore._reset();
  });

  afterEach(() => {
    appVersionStore._reset();
  });

  it("captures the first version as the boot baseline", () => {
    appVersionStore.recordVersion("abc123");
    const state = appVersionStore.getState();
    expect(state.bootedVersion).toBe("abc123");
    expect(state.latestVersion).toBe("abc123");
    expect(state.hasNewVersion).toBe(false);
  });

  it("does not fire hasNewVersion on repeated identical versions", () => {
    appVersionStore.recordVersion("abc");
    appVersionStore.recordVersion("abc");
    appVersionStore.recordVersion("abc");
    expect(appVersionStore.getState().hasNewVersion).toBe(false);
  });

  it("fires hasNewVersion when a different non-empty version arrives", () => {
    appVersionStore.recordVersion("abc");
    appVersionStore.recordVersion("def");
    const state = appVersionStore.getState();
    expect(state.bootedVersion).toBe("abc");
    expect(state.latestVersion).toBe("def");
    expect(state.hasNewVersion).toBe(true);
  });

  it("ignores 'dev' and empty strings", () => {
    appVersionStore.recordVersion("dev");
    appVersionStore.recordVersion("");
    appVersionStore.recordVersion("   ");
    appVersionStore.recordVersion(null);
    appVersionStore.recordVersion(undefined);
    expect(appVersionStore.getState().bootedVersion).toBeNull();
    expect(appVersionStore.getState().hasNewVersion).toBe(false);
  });

  it("notifies subscribers on state change", () => {
    const listener = vi.fn();
    const unsubscribe = appVersionStore.subscribe(listener);
    appVersionStore.recordVersion("v1");
    appVersionStore.recordVersion("v2");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    appVersionStore.recordVersion("v3");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("persists snooze to sessionStorage and reads it back", () => {
    appVersionStore.snoozeForMs(3_600_000);
    const raw = window.sessionStorage.getItem(APP_VERSION_SNOOZE_STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(Number(raw)).toBeGreaterThan(Date.now());
    expect(appVersionStore.getState().snoozeUntil).toBeGreaterThan(Date.now());
  });

  it("clearSnooze wipes storage", () => {
    appVersionStore.snoozeForMs(3_600_000);
    appVersionStore.clearSnooze();
    expect(
      window.sessionStorage.getItem(APP_VERSION_SNOOZE_STORAGE_KEY),
    ).toBeNull();
    expect(appVersionStore.getState().snoozeUntil).toBeNull();
  });
});

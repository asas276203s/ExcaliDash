import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APP_RESTORE_STORAGE_KEY,
  APP_RESTORE_TTL_MS,
  clearRestoreSnapshot,
  readRestoreSnapshot,
  stashRestoreSnapshot,
} from "./appVersionReload";

describe("appVersionReload", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("round-trips a snapshot", () => {
    stashRestoreSnapshot({ drawingId: "d1", unsavedElements: [{ id: "e1" }] });
    const snap = readRestoreSnapshot();
    expect(snap).toMatchObject({
      drawingId: "d1",
      unsavedElements: [{ id: "e1" }],
    });
    expect(typeof snap?.timestamp).toBe("number");
  });

  it("expires snapshots older than the TTL", () => {
    const stale = {
      drawingId: "d1",
      unsavedElements: [],
      timestamp: Date.now() - APP_RESTORE_TTL_MS - 1_000,
    };
    window.sessionStorage.setItem(
      APP_RESTORE_STORAGE_KEY,
      JSON.stringify(stale),
    );
    expect(readRestoreSnapshot()).toBeNull();
    expect(window.sessionStorage.getItem(APP_RESTORE_STORAGE_KEY)).toBeNull();
  });

  it("rejects malformed snapshots", () => {
    window.sessionStorage.setItem(APP_RESTORE_STORAGE_KEY, "{not-json");
    expect(readRestoreSnapshot()).toBeNull();
    window.sessionStorage.setItem(
      APP_RESTORE_STORAGE_KEY,
      JSON.stringify({ drawingId: 123, unsavedElements: [], timestamp: 0 }),
    );
    expect(readRestoreSnapshot()).toBeNull();
  });

  it("clearRestoreSnapshot wipes the key", () => {
    stashRestoreSnapshot({ drawingId: "d1", unsavedElements: [] });
    clearRestoreSnapshot();
    expect(window.sessionStorage.getItem(APP_RESTORE_STORAGE_KEY)).toBeNull();
  });
});

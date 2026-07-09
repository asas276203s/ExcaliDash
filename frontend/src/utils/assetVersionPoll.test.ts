import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appVersionStore } from "./appVersion";
import {
  ASSET_POLL_INTERVAL_MS,
  checkForNewAssetVersion,
  parseVersionPayload,
  startAssetVersionPolling,
} from "./assetVersionPoll";

const jsonResponse = (body: unknown, ok = true): Response =>
  ({
    ok,
    json: async () => body,
  }) as unknown as Response;

describe("parseVersionPayload", () => {
  it("extracts a non-empty version string", () => {
    expect(parseVersionPayload({ version: "abc123" })).toBe("abc123");
    expect(parseVersionPayload({ version: "  abc  " })).toBe("abc");
  });

  it("returns null for malformed payloads", () => {
    expect(parseVersionPayload(null)).toBeNull();
    expect(parseVersionPayload("nope")).toBeNull();
    expect(parseVersionPayload({})).toBeNull();
    expect(parseVersionPayload({ version: 42 })).toBeNull();
    expect(parseVersionPayload({ version: "" })).toBeNull();
  });
});

describe("checkForNewAssetVersion", () => {
  beforeEach(() => {
    appVersionStore._reset();
  });
  afterEach(() => {
    appVersionStore._reset();
  });

  it("flips hasNewVersion when served version differs from baked", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ version: "deployed-sha" }),
    );
    await checkForNewAssetVersion({ fetchImpl, baked: "running-sha" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    // cache-busted + no-store
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/^\/version\.json\?ts=\d+$/);
    expect(init).toMatchObject({ cache: "no-store" });
    expect(appVersionStore.getState().hasNewVersion).toBe(true);
  });

  it("does not fire when served version matches baked", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ version: "same" }));
    await checkForNewAssetVersion({ fetchImpl, baked: "same" });
    expect(appVersionStore.getState().hasNewVersion).toBe(false);
  });

  it("stays silent on network rejection", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    await checkForNewAssetVersion({ fetchImpl, baked: "running-sha" });
    expect(appVersionStore.getState().hasNewVersion).toBe(false);
  });

  it("stays silent on a 404 (deploy transition window)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ version: "x" }, false));
    await checkForNewAssetVersion({ fetchImpl, baked: "running-sha" });
    expect(appVersionStore.getState().hasNewVersion).toBe(false);
  });

  it("skips the network call entirely when there is no baked version", async () => {
    const fetchImpl = vi.fn();
    await checkForNewAssetVersion({ fetchImpl, baked: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(appVersionStore.getState().hasNewVersion).toBe(false);
  });
});

describe("startAssetVersionPolling", () => {
  beforeEach(() => {
    appVersionStore._reset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    appVersionStore._reset();
  });

  it("runs an immediate check then on the interval", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ version: "running-sha" }));
    const stop = startAssetVersionPolling({ fetchImpl, baked: "running-sha" });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // immediate
    await vi.advanceTimersByTimeAsync(ASSET_POLL_INTERVAL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(ASSET_POLL_INTERVAL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // stopped
  });

  it("re-checks on window focus", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ version: "running-sha" }));
    const stop = startAssetVersionPolling({ fetchImpl, baked: "running-sha" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus"));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    stop();
    window.dispatchEvent(new Event("focus"));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("is a no-op with no baked version", () => {
    const fetchImpl = vi.fn();
    const stop = startAssetVersionPolling({ fetchImpl, baked: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    stop();
  });
});

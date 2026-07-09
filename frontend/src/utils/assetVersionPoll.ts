/**
 * Frontend-bundle update detection.
 *
 * Why this exists: the `X-App-Version` header path (see `utils/appVersion.ts` +
 * `api/client.ts`) tracks the *backend* build. Frontend-only deploys never
 * change that header, so a long-lived tab running stale JS is never told to
 * reload. This poller closes that gap: it periodically fetches the deployed
 * `/version.json` and compares it to the version baked into the running bundle
 * (`__APP_BUILD_VERSION__`). A mismatch flips the same `hasNewVersion` flag the
 * banner already listens to — the two signals are complementary; either one
 * firing shows the banner.
 *
 * Failures (404 during the deploy transition window, offline, malformed JSON)
 * are swallowed silently — the next poll retries.
 */

import { appVersionStore } from "./appVersion";

export const VERSION_JSON_URL = "/version.json";
/** Poll cadence for long-lived tabs. */
export const ASSET_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * The version baked into *this* running bundle. `undefined` under vitest (the
 * Vite `define` isn't applied there); a git short SHA in local dev; the deploy
 * SHA (or `build-<timestamp>` fallback) in production.
 */
export const getBakedBuildVersion = (): string | null => {
  // Must reference the bare identifier so Vite's `define` substitutes it at
  // build time (member expressions like `globalThis.__APP_BUILD_VERSION__` are
  // NOT replaced). The `typeof` guard keeps it safe under vitest, where the
  // define isn't applied and the identifier is undeclared at runtime.
  const v =
    typeof __APP_BUILD_VERSION__ !== "undefined" ? __APP_BUILD_VERSION__ : null;
  return typeof v === "string" && v.length > 0 ? v : null;
};

/** Extract the `version` field from a parsed `/version.json` payload. */
export const parseVersionPayload = (data: unknown): string | null => {
  if (typeof data !== "object" || data === null) return null;
  const version = (data as { version?: unknown }).version;
  return typeof version === "string" && version.trim().length > 0
    ? version.trim()
    : null;
};

interface CheckOptions {
  fetchImpl?: typeof fetch;
  baked?: string | null;
}

/**
 * Fetch `/version.json` once and record the result. Cache-busted + `no-store`
 * so intermediate caches can't serve a stale file. Never throws.
 */
export const checkForNewAssetVersion = async (
  opts: CheckOptions = {},
): Promise<void> => {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const baked = opts.baked !== undefined ? opts.baked : getBakedBuildVersion();
  // No baseline to compare against (dev/test) → skip the network call entirely.
  if (!baked) return;
  if (typeof fetchImpl !== "function") return;
  try {
    const res = await fetchImpl(`${VERSION_JSON_URL}?ts=${Date.now()}`, {
      cache: "no-store",
    });
    if (!res || !res.ok) return; // 404 during deploy transition, etc.
    const data = await res.json();
    const fetched = parseVersionPayload(data);
    appVersionStore.recordAssetVersion(fetched, baked);
  } catch {
    // network error / offline / malformed JSON — stay silent, retry next poll.
  }
};

/**
 * Start polling for a newer frontend bundle: an immediate check, then every
 * {@link ASSET_POLL_INTERVAL_MS}, plus an opportunistic check whenever the tab
 * regains focus / visibility (a backgrounded tab is exactly when a deploy tends
 * to land). Returns a cleanup fn. No-op outside the browser or when there is no
 * baked version to compare (local dev/test).
 */
export const startAssetVersionPolling = (
  opts: CheckOptions = {},
): (() => void) => {
  if (typeof window === "undefined") return () => {};
  const baked = opts.baked !== undefined ? opts.baked : getBakedBuildVersion();
  if (!baked) return () => {};

  const run = () => {
    void checkForNewAssetVersion({ ...opts, baked });
  };

  run();
  const interval = window.setInterval(run, ASSET_POLL_INTERVAL_MS);

  const onFocus = () => run();
  const onVisibility = () => {
    if (document.visibilityState === "visible") run();
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    window.clearInterval(interval);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibility);
  };
};

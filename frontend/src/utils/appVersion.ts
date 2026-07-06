/**
 * Tracks the running backend build (X-App-Version header) so the SPA can
 * detect a new deploy and prompt for reload.
 *
 * Contract:
 *  - First response header sighted → `bootedVersion` (baseline).
 *  - Subsequent responses with a different, non-empty header → mark
 *    `hasNewVersion`. Never regress the flag back to false unless the user
 *    reloads or explicitly snoozes.
 *  - `"dev"` and empty strings are ignored so local dev doesn't fire.
 *  - Snooze persists in sessionStorage — cleared on tab reload by design.
 */

const SNOOZE_STORAGE_KEY = "excalidash-app-version-snooze-until";

export interface AppVersionState {
  bootedVersion: string | null;
  latestVersion: string | null;
  hasNewVersion: boolean;
  snoozeUntil: number | null;
}

type Listener = (state: AppVersionState) => void;

const isBrowser = typeof window !== "undefined";

const readSnoozeFromStorage = (): number | null => {
  if (!isBrowser) return null;
  try {
    const raw = window.sessionStorage?.getItem(SNOOZE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    if (parsed <= Date.now()) {
      window.sessionStorage.removeItem(SNOOZE_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

let state: AppVersionState = {
  bootedVersion: null,
  latestVersion: null,
  hasNewVersion: false,
  snoozeUntil: readSnoozeFromStorage(),
};

const listeners = new Set<Listener>();

const emit = () => {
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (err) {
      console.warn("[appVersion] listener threw", err);
    }
  }
};

const normalize = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === "dev" || trimmed === "unknown") return null;
  return trimmed;
};

export const appVersionStore = {
  getState: (): AppVersionState => state,

  subscribe: (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** Called by the axios response interceptor. */
  recordVersion: (headerValue: string | null | undefined): void => {
    const version = normalize(headerValue);
    if (!version) return;
    if (state.bootedVersion === null) {
      state = { ...state, bootedVersion: version, latestVersion: version };
      emit();
      return;
    }
    if (version === state.bootedVersion) {
      if (state.latestVersion !== version) {
        state = { ...state, latestVersion: version };
        emit();
      }
      return;
    }
    // Different from booted → new deploy detected.
    if (state.latestVersion === version && state.hasNewVersion) return;
    state = { ...state, latestVersion: version, hasNewVersion: true };
    emit();
  },

  snoozeForMs: (durationMs: number): void => {
    if (!isBrowser) return;
    const until = Date.now() + Math.max(0, durationMs);
    try {
      window.sessionStorage?.setItem(SNOOZE_STORAGE_KEY, String(until));
    } catch {
      // sessionStorage unavailable — snooze becomes memory-only for this session.
    }
    state = { ...state, snoozeUntil: until };
    emit();
  },

  clearSnooze: (): void => {
    if (isBrowser) {
      try {
        window.sessionStorage?.removeItem(SNOOZE_STORAGE_KEY);
      } catch {
        // ignore
      }
    }
    state = { ...state, snoozeUntil: null };
    emit();
  },

  /** Test-only: reset the module singleton. */
  _reset: (): void => {
    state = {
      bootedVersion: null,
      latestVersion: null,
      hasNewVersion: false,
      snoozeUntil: null,
    };
    listeners.clear();
  },
};

export const APP_VERSION_SNOOZE_STORAGE_KEY = SNOOZE_STORAGE_KEY;

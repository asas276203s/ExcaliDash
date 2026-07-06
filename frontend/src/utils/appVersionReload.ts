/**
 * Reload-and-restore mechanism for the app-update banner.
 *
 * When the user clicks "Reload" while an editor has unsaved local edits, we
 * stash a minimal snapshot in sessionStorage so the fresh bundle can restore
 * exactly what was on screen. The snapshot has a hard 5-minute TTL so a
 * stale reload can't zombie-restore work the user has since abandoned.
 */

export const APP_RESTORE_STORAGE_KEY = "excalidash-restore";
export const APP_RESTORE_TTL_MS = 5 * 60 * 1000;

export interface AppRestoreSnapshot {
  drawingId: string;
  unsavedElements: unknown[];
  timestamp: number;
}

const isBrowser = typeof window !== "undefined";

export const stashRestoreSnapshot = (
  snapshot: Omit<AppRestoreSnapshot, "timestamp">,
): void => {
  if (!isBrowser) return;
  try {
    const payload: AppRestoreSnapshot = {
      ...snapshot,
      timestamp: Date.now(),
    };
    window.sessionStorage?.setItem(
      APP_RESTORE_STORAGE_KEY,
      JSON.stringify(payload),
    );
  } catch {
    // sessionStorage full / disabled — reload proceeds without restore.
  }
};

export const readRestoreSnapshot = (): AppRestoreSnapshot | null => {
  if (!isBrowser) return null;
  try {
    const raw = window.sessionStorage?.getItem(APP_RESTORE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AppRestoreSnapshot;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.drawingId !== "string" ||
      !Array.isArray(parsed.unsavedElements) ||
      typeof parsed.timestamp !== "number"
    ) {
      window.sessionStorage.removeItem(APP_RESTORE_STORAGE_KEY);
      return null;
    }
    if (Date.now() - parsed.timestamp > APP_RESTORE_TTL_MS) {
      window.sessionStorage.removeItem(APP_RESTORE_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const clearRestoreSnapshot = (): void => {
  if (!isBrowser) return;
  try {
    window.sessionStorage?.removeItem(APP_RESTORE_STORAGE_KEY);
  } catch {
    // ignore
  }
};

export const performReload = (
  snapshot?: Omit<AppRestoreSnapshot, "timestamp">,
): void => {
  if (!isBrowser) return;
  if (snapshot) stashRestoreSnapshot(snapshot);
  try {
    window.location.reload();
  } catch {
    // In hostile environments the reload may throw — best-effort.
  }
};

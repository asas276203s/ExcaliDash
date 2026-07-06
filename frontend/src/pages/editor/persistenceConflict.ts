import type { MutableRefObject } from "react";
import { toast } from "sonner";
import * as api from "../../api";
import { diffCount, mergeElements } from "../../utils/element-merge";
import { getFilesDelta } from "./shared";

/**
 * Refs the conflict handler needs to keep in sync with the merged scene.
 * Kept minimal — the handler must not know about the full persistence hook.
 */
export interface ConflictRefs {
  currentDrawingVersion: MutableRefObject<number | null>;
  excalidrawAPI: MutableRefObject<any>;
  isSyncing: MutableRefObject<boolean>;
  latestElements: MutableRefObject<readonly any[]>;
  latestFiles: MutableRefObject<any>;
  lastPersistedElements: MutableRefObject<readonly any[]>;
  lastPersistedFiles: MutableRefObject<Record<string, any>>;
  lastSyncedFiles: MutableRefObject<Record<string, any>>;
}

export class DrawingSaveConflictError extends Error {
  constructor(message = "Drawing version conflict") {
    super(message);
    this.name = "DrawingSaveConflictError";
  }
}

interface ResolveArgs {
  drawingId: string;
  err: unknown;
  refs: ConflictRefs;
  localSnapshotElements: any[];
  localSnapshotFiles: Record<string, any>;
  persistableAppState: Record<string, any>;
}

interface ResolveResult {
  merged: any[];
  mergedFiles: Record<string, any>;
  nextFilesFlag: boolean;
}

/**
 * On 409 VERSION_CONFLICT from PUT /drawings/:id, fetch the latest server
 * scene, merge with the local snapshot, apply to the canvas, and return the
 * merged payload for the caller to retry the save with. Throws
 * `DrawingSaveConflictError` if the response is not a 409 or the recovery
 * cannot proceed.
 *
 * Side effects (in order):
 *  1. Fetch the fresh drawing.
 *  2. Merge fresh with local.
 *  3. Apply merged to the canvas (via `excalidrawAPI.updateScene`), guarded
 *     by `isSyncing` so onChange doesn't loop back into a save.
 *  4. Update baseline refs so a subsequent save targets the new server
 *     version and doesn't double-count files.
 *  5. Show a Traditional Chinese toast summarising the merge, with a 5s
 *     Undo action that restores the local pre-merge scene.
 */
export const resolveVersionConflict = async ({
  drawingId,
  err,
  refs,
  localSnapshotElements,
  localSnapshotFiles,
  persistableAppState,
}: ResolveArgs): Promise<ResolveResult> => {
  if (!api.isAxiosError(err) || err.response?.status !== 409) {
    throw err as Error;
  }
  const reportedVersion = Number(err.response?.data?.currentVersion);
  const hasReportedVersion =
    Number.isInteger(reportedVersion) && reportedVersion > 0;

  let fresh: Awaited<ReturnType<typeof api.getDrawing>>;
  try {
    fresh = await api.getDrawing(drawingId);
  } catch (fetchErr) {
    console.warn("[Editor] Failed to fetch fresh drawing after 409", fetchErr);
    if (hasReportedVersion) {
      refs.currentDrawingVersion.current = reportedVersion;
    }
    throw new DrawingSaveConflictError();
  }
  const freshElements = Array.isArray(fresh.elements)
    ? (fresh.elements as any[])
    : [];
  const freshFiles =
    fresh.files && typeof fresh.files === "object"
      ? (fresh.files as Record<string, any>)
      : {};
  const freshVersion =
    typeof fresh.version === "number" ? fresh.version : reportedVersion;

  const merged = mergeElements(localSnapshotElements, freshElements);
  const changeCount = diffCount(localSnapshotElements, freshElements);

  const excalApi = refs.excalidrawAPI.current;
  if (excalApi && typeof excalApi.updateScene === "function") {
    refs.isSyncing.current = true;
    try {
      excalApi.updateScene({
        elements: merged,
        appState: persistableAppState,
        captureUpdate: "NEVER",
      });
      const freshFilesArray = Object.values(freshFiles);
      if (
        freshFilesArray.length > 0 &&
        typeof excalApi.addFiles === "function"
      ) {
        excalApi.addFiles(freshFilesArray);
      }
    } finally {
      refs.isSyncing.current = false;
    }
  }

  const mergedFiles = { ...freshFiles, ...localSnapshotFiles };
  refs.latestElements.current = merged;
  refs.lastPersistedElements.current = freshElements;
  refs.latestFiles.current = mergedFiles;
  refs.lastPersistedFiles.current = freshFiles;
  refs.lastSyncedFiles.current = mergedFiles;
  if (Number.isInteger(freshVersion) && freshVersion > 0) {
    refs.currentDrawingVersion.current = freshVersion;
  }

  const restoreLocal = () => {
    const restoreApi = refs.excalidrawAPI.current;
    if (!restoreApi) return;
    refs.isSyncing.current = true;
    try {
      restoreApi.updateScene({
        elements: localSnapshotElements,
        appState: persistableAppState,
        captureUpdate: "NEVER",
      });
    } finally {
      refs.isSyncing.current = false;
    }
    refs.latestElements.current = localSnapshotElements;
  };

  toast.info(
    changeCount > 0
      ? `已合併其他來源的 ${changeCount} 處變更`
      : "已重新同步伺服器版本",
    {
      duration: 5000,
      action: {
        label: "復原",
        onClick: restoreLocal,
      },
    },
  );

  const nextFilesFlag =
    Object.keys(
      getFilesDelta(refs.lastPersistedFiles.current || {}, mergedFiles),
    ).length > 0;

  return { merged, mergedFiles, nextFilesFlag };
};

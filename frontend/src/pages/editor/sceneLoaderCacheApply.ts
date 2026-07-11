import type { MutableRefObject } from "react";
import { diagnostics } from "../../lib/diagnostics";

/**
 * Ref bundle the scene-cache appliers need. A subset of the scene loader's
 * refs — kept as its own type so the helpers stay decoupled from the full
 * loader surface.
 */
export interface SceneApplyRefs {
  latestElements: MutableRefObject<readonly any[]>;
  initialSceneElements: MutableRefObject<readonly any[]>;
  latestFiles: MutableRefObject<any>;
  lastSyncedFiles: MutableRefObject<Record<string, any>>;
  lastPersistedFiles: MutableRefObject<Record<string, any>>;
  currentDrawingVersion: MutableRefObject<number | null>;
  lastPersistedElements: MutableRefObject<readonly any[]>;
  elementVersionMap: MutableRefObject<Map<string, any>>;
  latestAppState: MutableRefObject<any>;
  excalidrawAPI: MutableRefObject<any>;
  isSyncing: MutableRefObject<boolean>;
}

/**
 * Factory for the two scene-cache application helpers used by
 * `useEditorSceneLoader`. Extracted to keep the loader file focused (and under
 * the repo's per-file line budget).
 *
 * - `primeSceneRefs` seeds every scene ref + records element versions from an
 *   authoritative element set. Shared by the warm-cache path and the cold
 *   fetch path so ref state is identical however the scene arrived.
 * - `applyFreshOverCache` applies a newer server payload onto an
 *   already-rendered cached scene (warm path, version bump). At mount there
 *   are no local edits yet, so a normalized replace to server truth is correct
 *   — this mirrors the collaboration fetch-merge apply, minus the merge
 *   because `latestElements` still equals the cached render.
 */
export const createSceneCacheApplier = (opts: {
  refs: SceneApplyRefs;
  recordElementVersion: (element: any) => void;
  drawingId: string | undefined;
  isCurrentLoad: () => boolean;
  isCancelled: () => boolean;
}) => {
  const { refs, recordElementVersion, drawingId, isCurrentLoad, isCancelled } = opts;

  const primeSceneRefs = (
    elements: readonly any[],
    files: Record<string, any>,
    version: number | null,
    hydratedAppState: any,
  ) => {
    refs.latestElements.current = elements;
    refs.initialSceneElements.current = elements;
    refs.latestFiles.current = files;
    refs.lastSyncedFiles.current = files;
    refs.lastPersistedFiles.current = files;
    refs.currentDrawingVersion.current = version;
    refs.lastPersistedElements.current = elements;
    refs.elementVersionMap.current.clear();
    elements.forEach((element: any) => recordElementVersion(element));
    refs.latestAppState.current = hydratedAppState;
  };

  const applyFreshOverCache = async (
    elements: readonly any[],
    persistedAppState: any,
    files: Record<string, any>,
    version: number | null,
  ) => {
    // Excalidraw mount + `excalidrawAPI` callback lands ~90ms after mount; the
    // revalidate fetch usually resolves later, but poll briefly in case it
    // wins the race.
    const deadline = Date.now() + 4000;
    while (
      !isCancelled() &&
      isCurrentLoad() &&
      (!refs.excalidrawAPI.current ||
        typeof refs.excalidrawAPI.current.updateScene !== "function") &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 16));
    }
    if (isCancelled() || !isCurrentLoad()) return;
    const api = refs.excalidrawAPI.current;
    if (!api || typeof api.updateScene !== "function") return;
    const hydratedAppState = { ...persistedAppState, collaborators: new Map() };
    refs.isSyncing.current = true;
    try {
      api.updateScene({
        elements,
        appState: hydratedAppState,
        captureUpdate: "NEVER",
      });
      const filesArray = Object.values(files);
      if (filesArray.length > 0 && typeof api.addFiles === "function") {
        api.addFiles(filesArray);
      }
    } finally {
      refs.isSyncing.current = false;
    }
    primeSceneRefs(elements, files, version, hydratedAppState);
    diagnostics.log("scene-cache-revalidate-applied", {
      drawingId,
      elementCount: elements.length,
      version,
    });
  };

  return { primeSceneRefs, applyFreshOverCache };
};

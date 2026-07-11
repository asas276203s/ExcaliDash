import { useCallback, useEffect, useRef } from "react";
import type { NavigateFunction } from "react-router-dom";
import type { MutableRefObject } from "react";
import { toast } from "sonner";
import * as api from "../../api";
import { diagnostics } from "../../lib/diagnostics";
import { normalizeServerElements } from "../../utils/normalize-server-elements";
import { getPersistedAppState, hasRenderableElements } from "./shared";
import { stripTabsFromSearch } from "../../utils/tabsStorage";
import {
  getCachedScene,
  setCachedScene,
  updateCachedSceneData,
  type CachedScene,
} from "./sceneCache";
import { createSceneCacheApplier } from "./sceneLoaderCacheApply";

type AccessLevel = "none" | "view" | "edit" | "owner";

type SceneLoaderParams = {
  id: string | undefined;
  user: unknown;
  location: {
    pathname: string;
    search: string;
    hash: string;
  };
  navigate: NavigateFunction;
  refs: {
    elementVersionMap: MutableRefObject<Map<string, any>>;
    saveQueue: MutableRefObject<Promise<void>>;
    latestElements: MutableRefObject<readonly any[]>;
    initialSceneElements: MutableRefObject<readonly any[]>;
    latestFiles: MutableRefObject<any>;
    lastSyncedFiles: MutableRefObject<Record<string, any>>;
    lastSyncedElementOrderSig: MutableRefObject<string>;
    lastPersistedFiles: MutableRefObject<Record<string, any>>;
    currentDrawingVersion: MutableRefObject<number | null>;
    lastPersistedElements: MutableRefObject<readonly any[]>;
    suspiciousBlankLoad: MutableRefObject<boolean>;
    hasSceneChangesSinceLoad: MutableRefObject<boolean>;
    excalidrawAPI: MutableRefObject<any>;
    latestAppState: MutableRefObject<any>;
    isBootstrappingScene: MutableRefObject<boolean>;
    hasHydratedInitialScene: MutableRefObject<boolean>;
    isSyncing: MutableRefObject<boolean>;
  };
  setAccessLevel: (accessLevel: AccessLevel) => void;
  setDrawingName: (name: string) => void;
  setInitialData: (data: any) => void;
  setIsReady: (ready: boolean) => void;
  setIsSceneLoading: (loading: boolean) => void;
  setLoadError: (error: string | null) => void;
  recordElementVersion: (element: any) => void;
};

const buildEmptyScene = () => ({
  elements: [],
  appState: {
    viewBackgroundColor: "#ffffff",
    gridSize: null,
    collaborators: new Map(),
  },
  files: {},
  scrollToContent: true,
});

export const useEditorSceneLoader = ({
  id,
  user,
  location,
  navigate,
  refs,
  setAccessLevel,
  setDrawingName,
  setInitialData,
  setIsReady,
  setIsSceneLoading,
  setLoadError,
  recordElementVersion,
}: SceneLoaderParams) => {
  const resetRefs = useCallback(() => {
    refs.isBootstrappingScene.current = true;
    refs.hasHydratedInitialScene.current = false;
    refs.elementVersionMap.current.clear();
    refs.saveQueue.current = Promise.resolve();
    refs.latestElements.current = [];
    refs.initialSceneElements.current = [];
    refs.latestFiles.current = {};
    refs.lastSyncedFiles.current = {};
    refs.lastSyncedElementOrderSig.current = "";
    refs.lastPersistedFiles.current = {};
    refs.currentDrawingVersion.current = null;
    refs.lastPersistedElements.current = [];
    refs.suspiciousBlankLoad.current = false;
    refs.hasSceneChangesSinceLoad.current = false;
    refs.excalidrawAPI.current = null;
  }, [refs]);

  // Defence in depth against tab-swap races: if the parent Editor is
  // NOT keyed by id for some reason (dev-tools swap, refactor regression,
  // etc.) an in-flight fetch for tab A can still resolve after the user
  // has switched to tab B and clobber B's state. Track each effect
  // invocation with a "run token" — whichever run is current at effect
  // start is captured in this ref; when the fetch resolves we discard
  // the result unless we're still the current run. See
  // `useEditorSceneLoader.race.test.ts` for the reproduction.
  const activeLoadTokenRef = useRef(0);

  useEffect(() => {
    const loadToken = ++activeLoadTokenRef.current;
    const isCurrentLoad = () => activeLoadTokenRef.current === loadToken;
    // Local teardown flag: set in this effect's cleanup so background work
    // (revalidate apply, API poll) never touches a torn-down Excalidraw.
    let cancelled = false;

    resetRefs();
    setLoadError(null);

    const { primeSceneRefs, applyFreshOverCache } = createSceneCacheApplier({
      refs,
      recordElementVersion,
      drawingId: id,
      isCurrentLoad,
      isCancelled: () => cancelled,
    });

    // Warm start: if we have a cached scene for this drawing, render it
    // instantly (no spinner) and revalidate against the server in the
    // background below. Strictly keyed by id — see sceneCache.ts invariants.
    const cached: CachedScene | null = getCachedScene(id);
    const isWarm = Boolean(cached);
    if (cached) {
      const hydratedAppState = { ...cached.appState, collaborators: new Map() };
      primeSceneRefs(cached.elements, cached.files, cached.version, hydratedAppState);
      refs.suspiciousBlankLoad.current = false;
      refs.hasSceneChangesSinceLoad.current = false;
      setDrawingName(cached.drawingName);
      setAccessLevel(cached.accessLevel);
      setLoadError(null);
      setInitialData({
        elements: cached.elements,
        appState: hydratedAppState,
        files: cached.files,
        scrollToContent: true,
        libraryItems: cached.libraryItems,
      });
      setIsSceneLoading(false);
      diagnostics.log("scene-cache-hit", {
        drawingId: id,
        elementCount: cached.elements.length,
        version: cached.version,
      });
    } else {
      setIsReady(false);
      setIsSceneLoading(true);
      setInitialData(null);
    }

    const loadData = async () => {
      if (!id) {
        if (!isCurrentLoad()) return;
        setInitialData(buildEmptyScene());
        setIsSceneLoading(false);
        return;
      }
      diagnostics.log("scene-load-start", { drawingId: id, loadToken, warm: isWarm });
      try {
        const libraryItemsPromise = user
          ? api.getLibrary().catch((err) => {
              console.warn("Failed to load library, using empty:", err);
              return [];
            })
          : Promise.resolve([]);
        const [data, libraryItems] = await Promise.all([
          api.getDrawing(id),
          libraryItemsPromise,
        ]);
        if (!isCurrentLoad()) {
          // A newer load superseded us — do not touch state or refs, they
          // now belong to the newer drawing id.
          diagnostics.log("scene-load-abort", {
            drawingId: id,
            reason: "superseded",
            loadToken,
          });
          return;
        }
        const resolvedAccessLevel =
          data.accessLevel === "view" ||
          data.accessLevel === "edit" ||
          data.accessLevel === "owner"
            ? data.accessLevel
            : "owner";
        // Normalize on initial load too: the very first render of an
        // MCP-authored drawing (elements missing `groupIds` etc.) is the
        // "打開 dash 就白屏" path. See normalize-server-elements.ts.
        const elements = normalizeServerElements(data.elements);
        const files = data.files || {};
        const version = typeof data.version === "number" ? data.version : null;
        const hasPreview =
          typeof data.preview === "string" && data.preview.trim().length > 0;
        const loadedRenderable = hasRenderableElements(elements);
        const persistedAppState = getPersistedAppState(data.appState || {});
        // Refresh the cache with server truth for the next switch-back.
        setCachedScene(id, {
          version,
          drawingName: data.name,
          accessLevel: resolvedAccessLevel,
          elements,
          appState: persistedAppState,
          files,
          libraryItems,
          cachedAt: Date.now(),
        });
        diagnostics.log("scene-load-done", {
          drawingId: id,
          elementCount: elements.length,
          loadedRenderable,
          hasPreview,
          version,
          warm: isWarm,
          suspiciousBlankLoad: !loadedRenderable && hasPreview,
        });
        if (import.meta.env.DEV) {
          console.log("[Editor] Loaded drawing", {
            drawingId: id,
            elementCount: elements.length,
            loadedRenderable,
            hasPreview,
            version,
            warm: isWarm,
          });
        }
        // Always keep the drawing name / access level fresh even on a warm
        // start (they're cheap and might have changed server-side).
        setDrawingName(data.name);
        setAccessLevel(resolvedAccessLevel);
        if (isWarm) {
          // We already rendered the cached scene. Only touch the canvas if the
          // server has a strictly newer (or non-comparable) version — otherwise
          // the cached render is already correct, so we no-op to keep the
          // switch perfectly seamless.
          const cachedVersion = cached ? cached.version : null;
          const shouldApply =
            version === null ||
            cachedVersion === null ||
            version > cachedVersion;
          if (shouldApply) {
            void applyFreshOverCache(elements, persistedAppState, files, version);
          } else {
            diagnostics.log("scene-cache-revalidate-noop", {
              drawingId: id,
              version,
              cachedVersion,
            });
          }
        } else {
          refs.suspiciousBlankLoad.current = !loadedRenderable && hasPreview;
          refs.hasSceneChangesSinceLoad.current = false;
          const hydratedAppState = {
            ...persistedAppState,
            collaborators: new Map(),
          };
          primeSceneRefs(elements, files, version, hydratedAppState);
          setInitialData({
            elements,
            appState: hydratedAppState,
            files,
            scrollToContent: true,
            libraryItems,
          });
        }
      } catch (err) {
        if (!isCurrentLoad()) {
          // Superseded — swallow the error silently; the current run owns
          // any user-facing signalling for its own drawing id.
          return;
        }
        const status = api.isAxiosError(err) ? err.response?.status ?? null : null;
        // Warm start: the cached scene is already on screen and correct enough
        // to keep working from. A transient revalidate failure (network blip,
        // 5xx) must NOT blank it. Two exceptions we still honour because they
        // mean the cached view is no longer valid: 403 (access revoked -> the
        // scene loader owns the redirect to /shared) and 404 (drawing deleted).
        const isAccessOrGone = status === 403 || status === 404;
        if (isWarm && !isAccessOrGone) {
          diagnostics.log(
            "scene-cache-revalidate-error-ignored",
            {
              drawingId: id,
              message: err instanceof Error ? err.message : String(err),
              status,
            },
            "warn",
          );
          return;
        }
        diagnostics.log(
          "scene-load-error",
          {
            drawingId: id,
            message: err instanceof Error ? err.message : String(err),
            status,
          },
          "error",
        );
        console.error("Failed to load drawing", err);
        let message = "Failed to load drawing";
        if (api.isAxiosError(err)) {
          const responseMessage =
            typeof err.response?.data?.message === "string"
              ? err.response.data.message
              : null;
          if (responseMessage) {
            message = responseMessage;
          } else if (err.response?.status === 403) {
            message = "You do not have access to this drawing";
          } else if (err.response?.status === 404) {
            message = "Drawing not found";
          }
          if (
            err.response?.status === 403 &&
            id &&
            location.pathname.startsWith("/editor/")
          ) {
            navigate(
              `/shared/${id}${stripTabsFromSearch(location.search)}${location.hash}`,
              {
                replace: true,
              },
            );
            return;
          }
        }
        toast.error(message);
        refs.latestElements.current = [];
        refs.initialSceneElements.current = [];
        refs.latestFiles.current = {};
        refs.lastSyncedFiles.current = {};
        refs.lastSyncedElementOrderSig.current = "";
        refs.lastPersistedFiles.current = {};
        refs.currentDrawingVersion.current = null;
        refs.lastPersistedElements.current = [];
        refs.suspiciousBlankLoad.current = false;
        refs.hasSceneChangesSinceLoad.current = false;
        setLoadError(message);
        setInitialData(null);
      } finally {
        if (isCurrentLoad()) {
          setIsSceneLoading(false);
        }
      }
    };

    loadData();

    return () => {
      // Stop any in-flight background revalidate from touching the (about to be
      // torn-down) Excalidraw instance.
      cancelled = true;
      // Snapshot the live scene the user is leaving into the cache so switching
      // back restores exactly what they see now — including edits made after
      // the initial load (which the fetch-time cache write wouldn't have). Only
      // refreshes an existing entry; a bare unmount never fabricates one (see
      // updateCachedSceneData). Strictly keyed by this drawing's own id.
      if (id) {
        updateCachedSceneData(id, {
          version: refs.currentDrawingVersion.current,
          elements: refs.latestElements.current,
          appState: getPersistedAppState(refs.latestAppState.current || {}),
          files: refs.latestFiles.current || {},
        });
      }
    };
  }, [
    id,
    location.hash,
    location.pathname,
    location.search,
    navigate,
    recordElementVersion,
    refs,
    resetRefs,
    setAccessLevel,
    setDrawingName,
    setInitialData,
    setIsReady,
    setIsSceneLoading,
    setLoadError,
    user,
  ]);
};

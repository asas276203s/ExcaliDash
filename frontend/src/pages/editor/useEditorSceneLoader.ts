import { useCallback, useEffect, useRef } from "react";
import type { NavigateFunction } from "react-router-dom";
import type { MutableRefObject } from "react";
import { toast } from "sonner";
import * as api from "../../api";
import { getPersistedAppState, hasRenderableElements } from "./shared";

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

    resetRefs();
    setIsReady(false);
    setIsSceneLoading(true);
    setLoadError(null);
    setInitialData(null);

    const loadData = async () => {
      if (!id) {
        if (!isCurrentLoad()) return;
        setInitialData(buildEmptyScene());
        setIsSceneLoading(false);
        return;
      }
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
          return;
        }
        setDrawingName(data.name);
        setAccessLevel(
          data.accessLevel === "view" ||
            data.accessLevel === "edit" ||
            data.accessLevel === "owner"
            ? data.accessLevel
            : "owner",
        );
        const elements = data.elements || [];
        const files = data.files || {};
        const hasPreview =
          typeof data.preview === "string" && data.preview.trim().length > 0;
        const loadedRenderable = hasRenderableElements(elements);
        refs.suspiciousBlankLoad.current = !loadedRenderable && hasPreview;
        refs.hasSceneChangesSinceLoad.current = false;
        if (import.meta.env.DEV) {
          console.log("[Editor] Loaded drawing", {
            drawingId: id,
            elementCount: elements.length,
            loadedRenderable,
            hasPreview,
            version: data.version ?? null,
            suspiciousBlankLoad: refs.suspiciousBlankLoad.current,
          });
        }
        refs.latestElements.current = elements;
        refs.initialSceneElements.current = elements;
        refs.latestFiles.current = files;
        refs.lastSyncedFiles.current = files;
        refs.lastPersistedFiles.current = files;
        refs.currentDrawingVersion.current =
          typeof data.version === "number" ? data.version : null;
        refs.lastPersistedElements.current = elements;
        elements.forEach((element: any) => recordElementVersion(element));
        const persistedAppState = getPersistedAppState(data.appState || {});
        const hydratedAppState = {
          ...persistedAppState,
          collaborators: new Map(),
        };
        refs.latestAppState.current = hydratedAppState;
        setInitialData({
          elements,
          appState: hydratedAppState,
          files,
          scrollToContent: true,
          libraryItems,
        });
      } catch (err) {
        if (!isCurrentLoad()) {
          // Superseded — swallow the error silently; the current run owns
          // any user-facing signalling for its own drawing id.
          return;
        }
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
            navigate(`/shared/${id}${location.search}${location.hash}`, {
              replace: true,
            });
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

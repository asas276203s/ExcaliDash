import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import { io, type Socket } from "socket.io-client";
import { toast } from "sonner";
import * as api from "../../api";
import type { UserIdentity } from "../../utils/identity";
import {
  buildRemoteSceneUpdate,
  getPersistedAppState,
  haveSameElements,
} from "./shared";

interface Peer extends UserIdentity {
  isActive: boolean;
}

type UseEditorCollaborationInput = {
  drawingId?: string;
  me: UserIdentity;
  isReady: boolean;
  excalidrawAPI: MutableRefObject<any>;
  editorContainerRef: RefObject<HTMLDivElement>;
  lastSyncedFilesRef: MutableRefObject<Record<string, any>>;
  lastSyncedElementOrderSigRef: MutableRefObject<string>;
  latestElementsRef: MutableRefObject<readonly any[]>;
  latestFilesRef: MutableRefObject<any>;
  lastPersistedElementsRef: MutableRefObject<readonly any[]>;
  lastPersistedFilesRef: MutableRefObject<Record<string, any>>;
  currentDrawingVersionRef: MutableRefObject<number | null>;
  computeElementOrderSig: (elements: readonly any[]) => string;
  recordElementVersion: (element: any) => void;
  onAccessDenied: () => void;
};

/**
 * Debounce window (ms) collapsing rapid drawing-server-update socket events
 * into a single fetch-and-merge. Exposed for tests.
 */
export const SERVER_UPDATE_DEBOUNCE_MS = 500;

const getSocketUrl = () =>
  import.meta.env.VITE_API_URL === "/api"
    ? window.location.origin
    : import.meta.env.VITE_API_URL ||
      import.meta.env.VITE_DEV_BACKEND_URL ||
      "http://localhost:8000";

export const useEditorCollaboration = ({
  drawingId,
  me,
  isReady,
  excalidrawAPI,
  editorContainerRef,
  lastSyncedFilesRef,
  lastSyncedElementOrderSigRef,
  latestElementsRef,
  latestFilesRef,
  lastPersistedElementsRef,
  lastPersistedFilesRef,
  currentDrawingVersionRef,
  computeElementOrderSig,
  recordElementVersion,
  onAccessDenied,
}: UseEditorCollaborationInput) => {
  const [socketMe, setSocketMe] = useState<UserIdentity>(me);
  const socketMeRef = useRef<UserIdentity>(socketMe);
  const [peers, setPeers] = useState<Peer[]>([]);
  const socketRef = useRef<Socket | null>(null);
  const lastPresenceUsersRef = useRef<Peer[] | null>(null);
  const lastCursorEmit = useRef<number>(0);
  const cursorBuffer = useRef<Map<string, any>>(new Map());
  const animationFrameId = useRef<number>(0);
  const isSyncing = useRef(false);
  const pendingRemoteElementsRef = useRef<Map<string, any>>(new Map());
  const pendingRemoteFilesRef = useRef<Record<string, any>>({});
  const pendingRemoteElementOrderRef = useRef<string[] | null>(null);
  const remoteFlushScheduledRef = useRef(false);
  const remoteFlushRafIdRef = useRef<number | null>(null);
  const serverUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const serverUpdateFetchInFlightRef = useRef(false);
  const serverUpdatePendingRef = useRef(false);

  useEffect(() => {
    setSocketMe(me);
  }, [me.id, me.name, me.initials, me.color]);

  useEffect(() => {
    socketMeRef.current = socketMe;
  }, [socketMe]);

  useEffect(() => {
    if (!drawingId || !isReady) return;
    const socket = io(getSocketUrl(), {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      withCredentials: true,
    });
    socketRef.current = socket;
    if (import.meta.env.DEV) {
      (window as any).__EXCALIDASH_SOCKET_STATUS__ = {
        connected: socket.connected,
      };
      socket.on("connect", () => {
        (window as any).__EXCALIDASH_SOCKET_STATUS__ = { connected: true };
      });
      socket.on("disconnect", () => {
        (window as any).__EXCALIDASH_SOCKET_STATUS__ = { connected: false };
      });
    }
    socket.emit("join-room", { drawingId, user: me }, (payload: any) => {
      const serverUser = payload?.user;
      if (!serverUser || typeof serverUser.id !== "string") return;
      const next: UserIdentity = {
        id: serverUser.id,
        name: typeof serverUser.name === "string" ? serverUser.name : me.name,
        initials:
          typeof serverUser.initials === "string"
            ? serverUser.initials
            : me.initials,
        color:
          typeof serverUser.color === "string" ? serverUser.color : me.color,
      };
      socketMeRef.current = next;
      setSocketMe(next);
      const lastUsers = lastPresenceUsersRef.current;
      if (lastUsers) {
        setPeers(lastUsers.filter((u) => u.id !== next.id));
      }
    });
    const renderLoop = () => {
      if (cursorBuffer.current.size > 0 && excalidrawAPI.current) {
        const collaborators = new Map<string, any>(
          excalidrawAPI.current.getAppState().collaborators || [],
        );
        cursorBuffer.current.forEach((data, userId) => {
          collaborators.set(userId, data);
        });
        cursorBuffer.current.clear();
        const { sceneUpdate } = buildRemoteSceneUpdate({ collaborators });
        if (sceneUpdate) {
          excalidrawAPI.current.updateScene(sceneUpdate);
        }
      }
      animationFrameId.current = requestAnimationFrame(renderLoop);
    };
    renderLoop();
    socket.on("presence-update", (users: Peer[]) => {
      lastPresenceUsersRef.current = users;
      const selfId = socketMeRef.current.id;
      setPeers(users.filter((u) => u.id !== selfId));
      if (excalidrawAPI.current) {
        const collaborators = new Map<string, any>(
          excalidrawAPI.current.getAppState().collaborators || [],
        );
        users.forEach((user) => {
          if (!user.isActive && user.id !== selfId) {
            collaborators.delete(user.id);
          }
        });
        const { sceneUpdate } = buildRemoteSceneUpdate({ collaborators });
        if (sceneUpdate) {
          excalidrawAPI.current.updateScene(sceneUpdate);
        }
      }
    });
    socket.on("error", (payload: any) => {
      const message =
        typeof payload?.message === "string" ? payload.message : null;
      console.warn("[Editor] Socket error:", payload);
      if (message === "You do not have access to this drawing") {
        onAccessDenied();
        return;
      }
      if (message) toast.error(message);
    });
    socket.on("cursor-move", (data: any) => {
      cursorBuffer.current.set(data.userId, {
        pointer: data.pointer,
        button: data.button || "up",
        selectedElementIds: data.selectedElementIds || {},
        username: data.username,
        color: { background: data.color, stroke: data.color },
        id: data.userId,
      });
    });
    const hasNonEmptyArray = (value: unknown): value is any[] =>
      Array.isArray(value) && value.length > 0;
    const flushRemoteUpdates = () => {
      remoteFlushScheduledRef.current = false;
      remoteFlushRafIdRef.current = null;
      if (!excalidrawAPI.current) return;
      const hasPendingElements = pendingRemoteElementsRef.current.size > 0;
      const hasPendingFiles =
        Object.keys(pendingRemoteFilesRef.current || {}).length > 0;
      const pendingOrderRaw = pendingRemoteElementOrderRef.current;
      const hasPendingOrder = hasNonEmptyArray(pendingOrderRaw);
      if (!hasPendingElements && !hasPendingFiles && !hasPendingOrder) return;
      isSyncing.current = true;
      try {
        const pendingElements = Array.from(
          pendingRemoteElementsRef.current.values(),
        );
        pendingRemoteElementsRef.current.clear();
        const incomingFiles = pendingRemoteFilesRef.current || {};
        pendingRemoteFilesRef.current = {};
        const elementOrder = hasPendingOrder ? pendingOrderRaw : null;
        pendingRemoteElementOrderRef.current = null;
        const { sceneUpdate, mergedElements, nextFiles, shouldUpdateFiles } =
          buildRemoteSceneUpdate({
            localElements:
              excalidrawAPI.current.getSceneElementsIncludingDeleted(),
            pendingElements,
            elementOrder,
            lastSyncedFiles: lastSyncedFilesRef.current,
            incomingFiles,
          });
        if (
          shouldUpdateFiles &&
          typeof excalidrawAPI.current.addFiles === "function"
        ) {
          excalidrawAPI.current.addFiles(Object.values(incomingFiles));
        }
        if (mergedElements) {
          if (elementOrder) {
            lastSyncedElementOrderSigRef.current =
              computeElementOrderSig(mergedElements);
          }
          pendingElements.forEach((el: any) => {
            recordElementVersion(el);
          });
          if (sceneUpdate) excalidrawAPI.current.updateScene(sceneUpdate);
          latestElementsRef.current = mergedElements;
        } else if (sceneUpdate) {
          excalidrawAPI.current.updateScene(sceneUpdate);
        }
        if (shouldUpdateFiles) {
          latestFilesRef.current = nextFiles;
          lastSyncedFilesRef.current = nextFiles;
        }
      } finally {
        isSyncing.current = false;
      }
      const moreElements = pendingRemoteElementsRef.current.size > 0;
      const moreFiles =
        Object.keys(pendingRemoteFilesRef.current || {}).length > 0;
      const moreOrder = hasNonEmptyArray(pendingRemoteElementOrderRef.current);
      if (moreElements || moreFiles || moreOrder) {
        if (!remoteFlushScheduledRef.current) {
          remoteFlushScheduledRef.current = true;
          remoteFlushRafIdRef.current =
            requestAnimationFrame(flushRemoteUpdates);
        }
      }
    };
    const scheduleRemoteFlush = () => {
      if (remoteFlushScheduledRef.current) return;
      remoteFlushScheduledRef.current = true;
      remoteFlushRafIdRef.current = requestAnimationFrame(flushRemoteUpdates);
    };
    socket.on(
      "element-update",
      ({
        elements,
        files,
        elementOrder,
      }: {
        elements: any[];
        files?: Record<string, any>;
        elementOrder?: string[];
      }) => {
        if (Array.isArray(elements)) {
          for (const el of elements) {
            const id = el?.id;
            if (typeof id === "string" && id.length > 0) {
              pendingRemoteElementsRef.current.set(id, el);
            }
          }
        }
        if (files && typeof files === "object") {
          pendingRemoteFilesRef.current = {
            ...pendingRemoteFilesRef.current,
            ...files,
          };
        }
        if (Array.isArray(elementOrder) && elementOrder.length > 0) {
          pendingRemoteElementOrderRef.current = elementOrder;
        }
        scheduleRemoteFlush();
      },
    );
    const fetchAndMergeServerUpdate = async () => {
      if (!drawingId) return;
      if (serverUpdateFetchInFlightRef.current) {
        // Coalesce: mark pending and let the in-flight fetch handle it after.
        serverUpdatePendingRef.current = true;
        return;
      }
      serverUpdateFetchInFlightRef.current = true;
      try {
        const data = await api.getDrawing(drawingId);
        const responseVersion =
          typeof data.version === "number" ? data.version : null;
        const knownVersion = currentDrawingVersionRef.current;
        // No new server version to merge — skip.
        if (
          responseVersion !== null &&
          knownVersion !== null &&
          responseVersion === knownVersion
        ) {
          return;
        }
        const hasLocalPendingEdits = !haveSameElements(
          lastPersistedElementsRef.current,
          latestElementsRef.current,
        );
        if (hasLocalPendingEdits) {
          // Safe strategy: do not clobber unsaved local edits. The user's next
          // save hits the backend's version-conflict path, which is authoritative.
          toast.info("Server changes available — save your local edits first");
          return;
        }
        const elements = Array.isArray(data.elements) ? data.elements : [];
        const files =
          data.files && typeof data.files === "object" ? data.files : {};
        const persistedAppState = getPersistedAppState(data.appState || {});
        const excalApi = excalidrawAPI.current;
        if (excalApi && typeof excalApi.updateScene === "function") {
          isSyncing.current = true;
          try {
            excalApi.updateScene({
              elements,
              appState: persistedAppState,
              captureUpdate: "NEVER",
            });
            const filesArray = Object.values(files);
            if (filesArray.length > 0 && typeof excalApi.addFiles === "function") {
              excalApi.addFiles(filesArray);
            }
          } finally {
            isSyncing.current = false;
          }
        }
        // Sync all baseline refs so subsequent local saves target the new version.
        latestElementsRef.current = elements;
        latestFilesRef.current = files;
        lastSyncedFilesRef.current = files;
        lastPersistedFilesRef.current = files;
        lastPersistedElementsRef.current = elements;
        if (responseVersion !== null) {
          currentDrawingVersionRef.current = responseVersion;
        }
        lastSyncedElementOrderSigRef.current = computeElementOrderSig(elements);
        elements.forEach((el: any) => recordElementVersion(el));
        toast.success("Drawing updated from server");
      } catch (err) {
        console.warn("[Editor] Failed to fetch server-side drawing update", err);
      } finally {
        serverUpdateFetchInFlightRef.current = false;
        if (serverUpdatePendingRef.current) {
          serverUpdatePendingRef.current = false;
          // Re-run once more to pick up anything that arrived while we fetched.
          void fetchAndMergeServerUpdate();
        }
      }
    };
    socket.on("drawing-server-update", (payload: { drawingId?: string }) => {
      if (!payload?.drawingId || payload.drawingId !== drawingId) return;
      // Debounce: collapse a burst of events into one fetch after 500ms of quiet.
      if (serverUpdateTimerRef.current) {
        clearTimeout(serverUpdateTimerRef.current);
      }
      serverUpdateTimerRef.current = setTimeout(() => {
        serverUpdateTimerRef.current = null;
        void fetchAndMergeServerUpdate();
      }, SERVER_UPDATE_DEBOUNCE_MS);
    });
    const handleActivity = (isActive: boolean) => {
      socket.emit("user-activity", { drawingId, isActive });
    };
    const onFocus = () => handleActivity(true);
    const onBlur = () => handleActivity(false);
    const onMouseEnter = () => handleActivity(true);
    const onMouseLeave = () => handleActivity(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("mouseenter", onMouseEnter);
    document.addEventListener("mouseleave", onMouseLeave);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("mouseenter", onMouseEnter);
      document.removeEventListener("mouseleave", onMouseLeave);
      socket.off("presence-update");
      socket.off("error");
      socket.off("cursor-move");
      socket.off("element-update");
      socket.off("drawing-server-update");
      socket.disconnect();
      if (remoteFlushRafIdRef.current !== null) {
        cancelAnimationFrame(remoteFlushRafIdRef.current);
        remoteFlushRafIdRef.current = null;
      }
      remoteFlushScheduledRef.current = false;
      pendingRemoteElementsRef.current.clear();
      pendingRemoteFilesRef.current = {};
      pendingRemoteElementOrderRef.current = null;
      if (serverUpdateTimerRef.current) {
        clearTimeout(serverUpdateTimerRef.current);
        serverUpdateTimerRef.current = null;
      }
      serverUpdatePendingRef.current = false;
      cancelAnimationFrame(animationFrameId.current);
    };
  }, [
    drawingId,
    me,
    isReady,
    excalidrawAPI,
    editorContainerRef,
    lastSyncedFilesRef,
    lastSyncedElementOrderSigRef,
    latestElementsRef,
    latestFilesRef,
    lastPersistedElementsRef,
    lastPersistedFilesRef,
    currentDrawingVersionRef,
    computeElementOrderSig,
    recordElementVersion,
    onAccessDenied,
  ]);

  const onPointerUpdate = useCallback(
    (payload: any) => {
      const now = Date.now();
      if (now - lastCursorEmit.current > 50 && socketRef.current) {
        const self = socketMeRef.current;
        socketRef.current.emit("cursor-move", {
          pointer: payload.pointer,
          button: payload.button,
          username: self.name,
          userId: self.id,
          drawingId,
          color: self.color,
        });
        lastCursorEmit.current = now;
      }
    },
    [drawingId],
  );

  return {
    peers,
    socketMeRef,
    socketRef,
    isSyncing,
    onPointerUpdate,
  };
};

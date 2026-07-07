import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import { io, type Socket } from "socket.io-client";
import { toast } from "sonner";
import * as api from "../../api";
import type { UserIdentity } from "../../utils/identity";
import { mergeElements } from "../../utils/element-merge";
import {
  buildRemoteSceneUpdate,
  getPersistedAppState,
  hasRenderableElements,
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
  /**
   * BUG-17: bumped by the persistence layer after every successful self-save.
   * Each successful scene save produces one backend broadcast to the drawing
   * room; that broadcast fans out to the sender's own socket too. The
   * `drawing-server-update` handler decrements this counter to swallow the
   * echo — see the "self-echo suppression" branch there.
   */
  pendingSelfEchoCountRef: MutableRefObject<number>;
  /** Wall-clock ms of the last self-save success. Paired with the counter to
   *  guard against a stale marker from a lost/dropped broadcast. */
  lastSelfSavedAtRef: MutableRefObject<number>;
  computeElementOrderSig: (elements: readonly any[]) => string;
  recordElementVersion: (element: any) => void;
  onAccessDenied: () => void;
};

/**
 * Debounce window (ms) collapsing rapid drawing-server-update socket events
 * into a single fetch-and-merge. Exposed for tests.
 */
export const SERVER_UPDATE_DEBOUNCE_MS = 500;

/**
 * Hard timeout (ms) on the /drawings/:id fetch fired from the collab loop.
 * If backend hangs or the network stalls, we abort the request, dismiss the
 * sync pill, and log — better than a pill stuck spinning forever. See BUG-15.
 */
export const REMOTE_FETCH_TIMEOUT_MS = 10_000;

/**
 * F4 (Round 3): if the backend is genuinely dead we don't want the pending-
 * event chain to loop forever, each iteration eating REMOTE_FETCH_TIMEOUT_MS.
 * After this many consecutive timeouts we stop re-running until the next
 * successful fetch resets the counter. See BUG-15 tail.
 */
export const MAX_CONSECUTIVE_REMOTE_TIMEOUTS = 3;

/**
 * When `isRemoteSyncing` has been true for this long without the apply
 * landing, the UI escalates from the quiet bottom-right pill (Variant B)
 * to the centred backdrop overlay (Variant C). Meant to signal "this is
 * taking a moment, hold on".
 */
export const REMOTE_SYNC_ESCALATE_MS = 400;

/**
 * Ratio of incoming diff (elements added + removed) to the pre-apply
 * element count that triggers an immediate escalation to Variant C, even
 * before the 400ms delay elapses. A big diff means the canvas is about to
 * be visually replaced — worth the stronger cue.
 */
export const REMOTE_SYNC_ESCALATE_DIFF_RATIO = 0.3;

/**
 * BUG-17: TTL on the self-echo marker. A successful self-save records a
 * timestamp; if the corresponding broadcast doesn't come back within this
 * window we assume it was dropped and reset the pending counter so a
 * legitimate future peer broadcast is not silently swallowed. 3s is
 * comfortably above the 500ms socket → broadcast round-trip we measure in
 * practice while still short enough to reset before the next user save.
 */
export const SELF_ECHO_WINDOW_MS = 3_000;

const computeElementDiffRatio = (
  before: readonly any[],
  after: readonly any[],
): number => {
  const beforeIds = new Set<string>();
  for (const el of before) {
    if (el && typeof el.id === "string") beforeIds.add(el.id);
  }
  const afterIds = new Set<string>();
  for (const el of after) {
    if (el && typeof el.id === "string") afterIds.add(el.id);
  }
  let added = 0;
  for (const id of afterIds) if (!beforeIds.has(id)) added++;
  let removed = 0;
  for (const id of beforeIds) if (!afterIds.has(id)) removed++;
  // Normalise against the LARGER side so a full replace of a 10-element
  // scene with a 10-element scene (0 overlap) reads as ratio 1.0, not 2.0.
  const denom = Math.max(beforeIds.size, afterIds.size, 1);
  return (added + removed) / denom;
};

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
  pendingSelfEchoCountRef,
  lastSelfSavedAtRef,
  computeElementOrderSig,
  recordElementVersion,
  onAccessDenied,
}: UseEditorCollaborationInput) => {
  const [socketMe, setSocketMe] = useState<UserIdentity>(me);
  const socketMeRef = useRef<UserIdentity>(socketMe);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [isRemoteSyncing, setIsRemoteSyncing] = useState(false);
  const [isRemoteSyncEscalated, setIsRemoteSyncEscalated] = useState(false);
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
  // F4: bail out of the pending-event re-run chain after too many consecutive
  // timeouts so a hung backend can't keep the sync loop running forever. Reset
  // to 0 on any successful fetch (response landed, even if we skipped the apply).
  const consecutiveRemoteTimeoutsRef = useRef(0);
  // BUG-9: on cleanup we flip this ref, and every async continuation past
  // an `await` inside `fetchAndMergeServerUpdate` checks it. Prevents a
  // fetch that started before unmount from calling setState / touching
  // refs owned by the next mount.
  const isUnmountingRef = useRef(false);
  // Timer that flips the pill into Variant C after REMOTE_SYNC_ESCALATE_MS
  // of "still syncing". Cleared as soon as the sync completes (or unmounts).
  const escalateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setSocketMe(me);
  }, [me.id, me.name, me.initials, me.color]);

  useEffect(() => {
    socketMeRef.current = socketMe;
  }, [socketMe]);

  useEffect(() => {
    if (!drawingId || !isReady) return;
    // Reset the unmount flag on every (re-)mount. This is important because
    // useRef persists across mounts in strict-mode double-invocation and
    // during id-driven remounts triggered by the parent's `key={id}`.
    isUnmountingRef.current = false;
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
      socket.on("disconnect", () => {
        (window as any).__EXCALIDASH_SOCKET_STATUS__ = { connected: false };
      });
    }
    const handleJoinAck = (payload: any) => {
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
    };
    // Re-join the drawing's collab room on EVERY (re)connect. Rooms are
    // server-side state keyed by socket.id; socket.io's built-in auto-
    // reconnect assigns a NEW socket.id on each reconnect, so a client that
    // hit a transient network hiccup (tab suspend/resume, laptop sleep, mobile
    // network switch) is silently dropped from `drawing_${id}` and stops
    // receiving `drawing-server-update` broadcasts — including MCP writes.
    // Without this listener, some open editors miss updates and others
    // don't, exactly matching the flaky symptom users reported. Server-side
    // join-room is idempotent (users filtered by id + socket.join no-op on
    // repeat), so a duplicate emit at first connect is harmless.
    socket.on("connect", () => {
      if (import.meta.env.DEV) {
        (window as any).__EXCALIDASH_SOCKET_STATUS__ = { connected: true };
      }
      // F4: reset the consecutive-timeout give-up counter on every fresh
      // connect. A reconnect is our strongest signal that the client can
      // reach the server again; give sync a clean slate.
      consecutiveRemoteTimeoutsRef.current = 0;
      socket.emit("join-room", { drawingId, user: me }, handleJoinAck);
    });
    // In tests the mock socket reports connected: true synchronously; in
    // production socket.connected is false until the first real connect
    // event, at which point the listener above fires.
    if (socket.connected) {
      socket.emit("join-room", { drawingId, user: me }, handleJoinAck);
    }
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
    // BUG-13: harden against malformed socket payloads. The server-side
    // emit is trusted today, but a stray broadcast from a compromised /
    // buggy peer must NOT crash the editor. Guard the top-level payload
    // shape first, THEN the individual field types. Previously the outer
    // destructure could throw if payload was null.
    socket.on("element-update", (payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const { elements, files, elementOrder } = payload as {
        elements?: unknown;
        files?: unknown;
        elementOrder?: unknown;
      };
      if (Array.isArray(elements)) {
        for (const el of elements) {
          const id = (el as { id?: unknown } | null | undefined)?.id;
          if (typeof id === "string" && id.length > 0) {
            pendingRemoteElementsRef.current.set(id, el);
          }
        }
      }
      if (files && typeof files === "object" && !Array.isArray(files)) {
        pendingRemoteFilesRef.current = {
          ...pendingRemoteFilesRef.current,
          ...(files as Record<string, any>),
        };
      }
      if (Array.isArray(elementOrder) && elementOrder.length > 0) {
        pendingRemoteElementOrderRef.current = elementOrder as string[];
      }
      scheduleRemoteFlush();
    });
    // A remote-driven `updateScene({ elements })` mid-drag was crashing the
    // editor: Excalidraw's internal `pointerDownState` holds identity refs
    // into the pre-swap elements array (the element being dragged / resized
    // / drawn), and swapping the whole array out from under it makes the
    // next pointermove/pointerup handler dereference a stale element.
    //
    // The fix is lock-and-apply: while a user gesture is in progress we
    // hold the merge back, then briefly lock the canvas and apply. Callers
    // observing `isRemoteSyncing` render an overlay so the user sees what
    // is happening; the overlay is not shown during the gesture wait so we
    // don't yank feedback out of an in-progress drag.
    const isUserGestureActive = (): boolean => {
      const api = excalidrawAPI.current;
      if (!api || typeof api.getAppState !== "function") return false;
      let state: any;
      try {
        state = api.getAppState();
      } catch {
        return false;
      }
      if (!state) return false;
      return Boolean(
        state.cursorButton === "down" ||
          state.newElement ||
          state.resizingElement ||
          state.selectionElement ||
          state.multiElement ||
          state.editingLinearElement ||
          state.editingTextElement ||
          state.selectedElementsAreBeingDragged ||
          state.isRotating ||
          state.isResizing ||
          state.isCropping,
      );
    };
    const waitForGestureEnd = () =>
      new Promise<void>((resolve) => {
        const start = Date.now();
        // Hard ceiling — if something wedges pointerDown state true for
        // >5s we still apply, but log so we know.
        const HARD_TIMEOUT_MS = 5_000;
        const tick = () => {
          if (!isUserGestureActive()) return resolve();
          if (Date.now() - start > HARD_TIMEOUT_MS) {
            console.warn(
              "[Editor] Gave up waiting for gesture end after 5s — applying remote update anyway",
            );
            return resolve();
          }
          requestAnimationFrame(tick);
        };
        tick();
      });
    // Turn the sync pill ON and schedule the Variant C escalation timer.
    // Two triggers escalate B → C:
    //   1. Wall-clock delay: if the sync has been visible for
    //      REMOTE_SYNC_ESCALATE_MS without unlocking, promote automatically.
    //   2. Diff-size: computed at apply time (see below), promotes
    //      immediately if the incoming payload rewrites >30% of the scene.
    const beginRemoteSyncUI = () => {
      if (isUnmountingRef.current) return;
      setIsRemoteSyncing(true);
      if (escalateTimerRef.current) {
        clearTimeout(escalateTimerRef.current);
      }
      escalateTimerRef.current = setTimeout(() => {
        escalateTimerRef.current = null;
        if (isUnmountingRef.current) return;
        setIsRemoteSyncEscalated(true);
      }, REMOTE_SYNC_ESCALATE_MS);
    };
    const escalateRemoteSyncUI = () => {
      if (isUnmountingRef.current) return;
      if (escalateTimerRef.current) {
        clearTimeout(escalateTimerRef.current);
        escalateTimerRef.current = null;
      }
      setIsRemoteSyncEscalated(true);
    };
    const endRemoteSyncUI = () => {
      if (escalateTimerRef.current) {
        clearTimeout(escalateTimerRef.current);
        escalateTimerRef.current = null;
      }
      // Note: setState after unmount is a silent no-op in React 18, but
      // we still guard for symmetry with beginRemoteSyncUI and so
      // future refs / effects added here don't leak.
      if (isUnmountingRef.current) return;
      setIsRemoteSyncing(false);
      setIsRemoteSyncEscalated(false);
    };
    const fetchAndMergeServerUpdate = async () => {
      if (!drawingId) return;
      if (isUnmountingRef.current) return;
      // F4: once we've given up on the server, skip fresh attempts too. The
      // socket-connect handler resets the counter so a genuine reconnect gets
      // a clean slate. Falling through here means we never mount a pill for
      // a request that we won't actually service.
      if (
        consecutiveRemoteTimeoutsRef.current >=
        MAX_CONSECUTIVE_REMOTE_TIMEOUTS
      ) {
        return;
      }
      if (serverUpdateFetchInFlightRef.current) {
        // Coalesce: mark pending and let the in-flight fetch handle it after.
        serverUpdatePendingRef.current = true;
        return;
      }
      serverUpdateFetchInFlightRef.current = true;
      // F4/F3 (Round 3): light the sync pill IMMEDIATELY when we commit to a
      // fetch, not after the response lands. Previously beginRemoteSyncUI
      // was called post-fetch, which meant a stalled backend never showed
      // any feedback (the pill was invisible for the full 10s abort
      // window). Now the pill goes on now, and the catch/finally chain
      // dismisses it whether the fetch succeeds, times out, or errors.
      beginRemoteSyncUI();
      // BUG-15: hard cap the fetch. AbortController fires after
      // REMOTE_FETCH_TIMEOUT_MS, causing axios to reject with a
      // CanceledError. We catch it below and dismiss the pill instead
      // of leaving it stuck.
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort();
      }, REMOTE_FETCH_TIMEOUT_MS);
      try {
        const data = await api.getDrawing(drawingId, {
          signal: abortController.signal,
        });
        // F4: a response landed → server is alive → reset the consecutive-
        // timeout counter. Doing this BEFORE the unmount bail-out so a
        // late-arriving success still clears the counter (harmless — the
        // ref writes below are guarded by isUnmountingRef).
        consecutiveRemoteTimeoutsRef.current = 0;
        // BUG-9: bail out cleanly if we were unmounted while the fetch
        // was in flight. Every mutation past this point touches refs
        // that now belong to the next mount (or to nothing).
        if (isUnmountingRef.current) return;
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
        const hasLocalPendingEdits = () =>
          !haveSameElements(
            lastPersistedElementsRef.current,
            latestElementsRef.current,
          );
        // Hold the apply until the user's gesture completes. This is the
        // core of the crash fix — see `isUserGestureActive` above. Doing
        // this BEFORE the pending-edits check because pending edits from
        // the just-ending gesture will auto-save shortly, and the apply +
        // 409-auto-merge handles the collision cleanly (see Designer
        // spec §1.A criterion 3: "Remote update applies AFTER pointerup").
        if (isUserGestureActive()) {
          await waitForGestureEnd();
          if (isUnmountingRef.current) return;
          // Note: we intentionally do NOT re-check hasLocalPendingEdits()
          // after the gesture ends. Those pending edits are from THIS
          // gesture, and the next autosave will hit the version-conflict
          // auto-merge path (see commit 0896f88). Blocking the apply here
          // would break the test-matrix "both survive" acceptance.
        } else if (hasLocalPendingEdits()) {
          // No active gesture but pending edits — user has stale unsaved
          // work from before. Refuse to clobber; wait for their save.
          toast.info("Server 有更新、請先儲存你的改動");
          return;
        }
        const elements = Array.isArray(data.elements) ? data.elements : [];
        const files =
          data.files && typeof data.files === "object" ? data.files : {};
        // BUG-14 (refined by F1 Round 3): mirror the suspiciousBlankLoad
        // guard from the scene loader. If the backend transiently returns
        // an empty payload (mid-migration, a lost broadcast, or an actual
        // bug) while our local scene still has renderable content AND the
        // server tells us it has a preview, refuse to clobber.
        //
        // HOWEVER, a legitimate MCP delete-all also produces this shape
        // (empty elements, preview from before the delete not yet nulled).
        // Distinguish the two by version bump: if `responseVersion` is
        // strictly greater than `knownVersion`, the server has clearly
        // recorded an intentional write — apply it. Only skip if version
        // did NOT bump (transient corruption or same-version echo).
        const incomingRenderable = hasRenderableElements(elements);
        const localRenderable = hasRenderableElements(
          latestElementsRef.current,
        );
        const hasServerPreview =
          typeof data.preview === "string" && data.preview.trim().length > 0;
        const versionDidBump =
          responseVersion !== null &&
          knownVersion !== null &&
          responseVersion > knownVersion;
        if (
          !incomingRenderable &&
          localRenderable &&
          hasServerPreview &&
          !versionDidBump
        ) {
          console.warn(
            "[Editor] Ignored suspicious blank remote payload — local scene has content, server advertised a preview, and version did not bump",
            { drawingId, responseVersion, knownVersion },
          );
          return;
        }
        const persistedAppState = getPersistedAppState(data.appState || {});
        const excalApi = excalidrawAPI.current;
        // BUG-18: merge the server payload with Excalidraw's *current* scene
        // state rather than blindly replacing it. Two motivating scenarios:
        //   1. Broadcast lands while the user is mid-draw. Excalidraw's
        //      scene holds an in-progress element that hasn't been persisted
        //      or even flushed to latestElementsRef yet. A full replace
        //      clobbers it, and the subsequent handleCanvasChange resets
        //      the debounced-save args to the truncated state, silently
        //      losing the work.
        //   2. Peer or MCP tool sends an empty payload (patch_drawing with
        //      delete-all). Version bumped, so the suspiciousBlankLoad
        //      guard doesn't fire. Replacing with `[]` would blank the
        //      canvas even when the local user still had valid unsaved
        //      work — the "有時候更新之後 canvas 白屏" symptom users hit.
        // Using the same reconcileElements-based merge the 409 auto-merge
        // uses in resolveVersionConflict keeps the two paths symmetric:
        // higher-version elements win, so a peer's Ctrl+A + Delete
        // (elements marked isDeleted with bumped versions) still wipes the
        // canvas, but a bare MCP-style delete-all is treated as "the
        // element the client is still holding is authoritative until the
        // client saves it".
        const localSceneForMerge =
          excalApi && typeof excalApi.getSceneElementsIncludingDeleted === "function"
            ? excalApi.getSceneElementsIncludingDeleted()
            : latestElementsRef.current;
        const mergedElements = mergeElements(localSceneForMerge, elements);
        // Pill is already visible (lit at the top of fetchAndMerge). If the
        // incoming diff is big, jump straight to Variant C — don't wait
        // 400ms for the escalation timer.
        const diffRatio = computeElementDiffRatio(
          latestElementsRef.current,
          mergedElements,
        );
        if (diffRatio > REMOTE_SYNC_ESCALATE_DIFF_RATIO) {
          escalateRemoteSyncUI();
        }
        if (excalApi && typeof excalApi.updateScene === "function") {
          isSyncing.current = true;
          try {
            excalApi.updateScene({
              elements: mergedElements,
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
        // Sync baseline refs. latestElementsRef mirrors what's on the canvas
        // (the merge result) so subsequent handleCanvasChange doesn't down-
        // grade it. lastPersistedElementsRef reflects what the SERVER
        // actually has (raw fetched elements) — the drift between the two
        // is what the next debouncedSave detects and reconciles via the
        // 409 auto-merge path.
        latestElementsRef.current = mergedElements;
        latestFilesRef.current = files;
        lastSyncedFilesRef.current = files;
        lastPersistedFilesRef.current = files;
        lastPersistedElementsRef.current = elements;
        if (responseVersion !== null) {
          currentDrawingVersionRef.current = responseVersion;
        }
        lastSyncedElementOrderSigRef.current =
          computeElementOrderSig(mergedElements);
        mergedElements.forEach((el: any) => recordElementVersion(el));
        toast.success("已從 Server 同步最新內容");
      } catch (err) {
        // BUG-15: distinguish the abort we caused from a real network error.
        const isAbort =
          (err as { name?: string } | null | undefined)?.name ===
            "CanceledError" ||
          (err as { name?: string } | null | undefined)?.name === "AbortError";
        if (isAbort) {
          // F4: track consecutive timeouts so we can stop re-running when
          // the backend is genuinely dead.
          consecutiveRemoteTimeoutsRef.current += 1;
          console.warn(
            "[Editor] Remote update fetch aborted after " +
              REMOTE_FETCH_TIMEOUT_MS +
              "ms — dismissing sync pill (consecutive timeouts: " +
              consecutiveRemoteTimeoutsRef.current +
              ")",
          );
        } else {
          console.warn(
            "[Editor] Failed to fetch server-side drawing update",
            err,
          );
        }
      } finally {
        clearTimeout(timeoutId);
        serverUpdateFetchInFlightRef.current = false;
        endRemoteSyncUI();
        // F4: gate the pending re-run on the consecutive-timeout counter.
        // If we've hit MAX_CONSECUTIVE_REMOTE_TIMEOUTS in a row, the
        // backend is very likely dead; drop the pending flag and stop.
        // The next successful fetch (or new event flow that resets the
        // counter) will restart the chain.
        if (
          consecutiveRemoteTimeoutsRef.current >=
          MAX_CONSECUTIVE_REMOTE_TIMEOUTS
        ) {
          if (serverUpdatePendingRef.current) {
            console.warn(
              "[Editor] Giving up on server sync after " +
                MAX_CONSECUTIVE_REMOTE_TIMEOUTS +
                " consecutive timeouts — server unreachable",
            );
          }
          serverUpdatePendingRef.current = false;
        } else if (
          serverUpdatePendingRef.current &&
          !isUnmountingRef.current
        ) {
          serverUpdatePendingRef.current = false;
          // Re-run once more to pick up anything that arrived while we fetched.
          void fetchAndMergeServerUpdate();
        }
      }
    };
    socket.on("drawing-server-update", (payload: { drawingId?: string }) => {
      if (!payload?.drawingId || payload.drawingId !== drawingId) return;
      // BUG-17: self-echo suppression. The backend fans a scene write out
      // to the whole `drawing_${id}` room, including the socket that just
      // issued the save. Without this guard the sender flashes the "同步中"
      // pill for their own edit — nothing to actually apply (our
      // currentDrawingVersion is already at the new value from the save's
      // response), just visual noise. The persistence layer bumps
      // `pendingSelfEchoCountRef` once per successful save; we decrement
      // once per broadcast within the TTL window. Consuming markers one-
      // at-a-time keeps peer updates that race with our saves visible —
      // each peer save produces its own broadcast event, which either
      // arrives before our marker is set or fires after it's consumed.
      // See SELF_ECHO_WINDOW_MS for the TTL rationale.
      const now = Date.now();
      const pendingEchoes = pendingSelfEchoCountRef.current;
      const lastSelfSaveAt = lastSelfSavedAtRef.current;
      const withinSelfEchoWindow =
        lastSelfSaveAt > 0 && now - lastSelfSaveAt < SELF_ECHO_WINDOW_MS;
      if (pendingEchoes > 0 && withinSelfEchoWindow) {
        pendingSelfEchoCountRef.current = pendingEchoes - 1;
        // Skip both pill and debounced fetch — there is nothing new to
        // pull; our save already synced the local baseline refs. If we
        // scheduled a fetch here it would return the same version we
        // already know (see the early-return in fetchAndMergeServerUpdate
        // where responseVersion === knownVersion), so the fetch is pure
        // overhead.
        return;
      }
      if (pendingEchoes > 0 && !withinSelfEchoWindow) {
        // Marker expired without its broadcast — could be a dropped
        // packet or clock skew. Reset so a legitimate future peer
        // broadcast is not silently swallowed. Fall through into the
        // normal (peer / MCP) flow.
        pendingSelfEchoCountRef.current = 0;
      }
      // F4/F3 (Round 3): light the pill on the leading edge of the burst,
      // not once the debounced fetch starts. The persistence layer's
      // 409-auto-merge (see 0896f88) can finish an entire apply cycle
      // before our 500ms debounce fires, and if we only light the pill
      // at fetch time we'd have no user-visible feedback for the actual
      // sync window. Dismiss happens in the fetch's finally block.
      if (
        !serverUpdateTimerRef.current &&
        !serverUpdateFetchInFlightRef.current
      ) {
        beginRemoteSyncUI();
      }
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
      // BUG-9: any in-flight fetchAndMergeServerUpdate reads this ref
      // after each `await`. Flip it FIRST so continuations bail early
      // instead of touching the (now-stale) refs.
      isUnmountingRef.current = true;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("mouseenter", onMouseEnter);
      document.removeEventListener("mouseleave", onMouseLeave);
      socket.off("connect");
      socket.off("disconnect");
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
      if (escalateTimerRef.current) {
        clearTimeout(escalateTimerRef.current);
        escalateTimerRef.current = null;
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
    pendingSelfEchoCountRef,
    lastSelfSavedAtRef,
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
    isRemoteSyncing,
    isRemoteSyncEscalated,
    onPointerUpdate,
  };
};

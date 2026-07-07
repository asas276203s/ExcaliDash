import { act, renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
import type { MutableRefObject, RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Module mocks ---------------------------------------------------------
// Fake socket. Handlers are captured so tests can invoke them synchronously.
type SocketHandler = (...args: any[]) => void;
const socketHandlers = new Map<string, SocketHandler>();
const fakeSocket = {
  on: vi.fn((event: string, handler: SocketHandler) => {
    socketHandlers.set(event, handler);
  }),
  off: vi.fn((event: string) => {
    socketHandlers.delete(event);
  }),
  emit: vi.fn(),
  disconnect: vi.fn(),
  connected: true,
};
vi.mock("socket.io-client", () => ({
  io: vi.fn(() => fakeSocket),
}));

// Toast spies so tests can assert user-facing messages.
const toastInfo = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    info: (...args: any[]) => toastInfo(...args),
    success: (...args: any[]) => toastSuccess(...args),
    error: (...args: any[]) => toastError(...args),
  },
}));

// Drawing fetch. Each test rebinds `getDrawingImpl`. The 2nd arg is the
// options bag (currently { signal }); tests may inspect it via the shared
// spy exposed below.
const getDrawingSpy = vi.fn(async (_id: string, _opts?: any) => ({} as any));
let getDrawingImpl: (id: string, opts?: any) => Promise<any> = async () => ({});
vi.mock("../../api", () => ({
  getDrawing: (id: string, opts?: any) => {
    getDrawingSpy(id, opts);
    return getDrawingImpl(id, opts);
  },
  // Passthrough — the hook doesn't use these but the module barrel re-exports.
  getLibrary: vi.fn(async () => []),
  isAxiosError: vi.fn(() => false),
}));

// -------------------------------------------------------------------------
import {
  useEditorCollaboration,
  SERVER_UPDATE_DEBOUNCE_MS,
  REMOTE_FETCH_TIMEOUT_MS,
  REMOTE_SYNC_ESCALATE_MS,
  MAX_CONSECUTIVE_REMOTE_TIMEOUTS,
} from "./useEditorCollaboration";
import { diagnostics } from "../../lib/diagnostics";

const makeRef = <T>(value: T): MutableRefObject<T> => ({ current: value });

type HookArgs = Parameters<typeof useEditorCollaboration>[0];

const buildProps = (overrides: Partial<HookArgs> = {}): HookArgs => {
  const excalApi = {
    updateScene: vi.fn(),
    addFiles: vi.fn(),
    getAppState: vi.fn(() => ({ collaborators: new Map() })),
    getSceneElementsIncludingDeleted: vi.fn(() => []),
    getFiles: vi.fn(() => ({})),
  };
  const editorContainerRef = createRef<HTMLDivElement>() as RefObject<HTMLDivElement>;
  return {
    drawingId: "d1",
    me: { id: "u1", name: "Alice", initials: "A", color: "#000" },
    isReady: true,
    excalidrawAPI: makeRef<any>(excalApi),
    editorContainerRef,
    lastSyncedFilesRef: makeRef<Record<string, any>>({}),
    lastSyncedElementOrderSigRef: makeRef(""),
    latestElementsRef: makeRef<readonly any[]>([]),
    latestFilesRef: makeRef<any>({}),
    lastPersistedElementsRef: makeRef<readonly any[]>([]),
    lastPersistedFilesRef: makeRef<Record<string, any>>({}),
    currentDrawingVersionRef: makeRef<number | null>(1),
    myUserId: "u1",
    computeElementOrderSig: (els: readonly any[]) =>
      els.map((e: any) => e.id).join(","),
    recordElementVersion: vi.fn(),
    onAccessDenied: vi.fn(),
    ...overrides,
  };
};

// Fires the socket event exactly like the backend does. Accepts either a bare
// drawingId (legacy positional form) or an options bag carrying the write
// origin (originSessionId / originUserId) the backend now stamps on the
// broadcast payload.
const emitServerUpdate = (
  drawingIdOrOpts:
    | string
    | {
        drawingId?: string;
        originSessionId?: string | null;
        originUserId?: string | null;
      } = "d1",
) => {
  const opts =
    typeof drawingIdOrOpts === "string"
      ? { drawingId: drawingIdOrOpts }
      : drawingIdOrOpts;
  const handler = socketHandlers.get("drawing-server-update");
  if (!handler) throw new Error("drawing-server-update handler not registered");
  handler({
    drawingId: opts.drawingId ?? "d1",
    originSessionId: opts.originSessionId ?? null,
    originUserId: opts.originUserId ?? null,
  });
};

describe("useEditorCollaboration drawing-server-update", () => {
  const originalLocation = window.location;
  const reloadSpy = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    socketHandlers.clear();
    fakeSocket.on.mockClear();
    fakeSocket.off.mockClear();
    fakeSocket.emit.mockClear();
    fakeSocket.disconnect.mockClear();
    toastInfo.mockClear();
    toastSuccess.mockClear();
    toastError.mockClear();
    getDrawingSpy.mockClear();
    // Guard: fail the test if anything calls window.location.reload().
    // jsdom's location has non-configurable props, so replace the whole object.
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        ...originalLocation,
        reload: reloadSpy,
      },
    });
    reloadSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it("never calls window.location.reload on drawing-server-update", async () => {
    const props = buildProps();
    getDrawingImpl = async () => ({
      id: "d1",
      elements: [{ id: "e1", isDeleted: false }],
      appState: {},
      files: {},
      version: 2,
    });
    renderHook(() => useEditorCollaboration(props));
    emitServerUpdate();
    await act(async () => {
      vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
    });
    await vi.waitFor(() => {
      expect(props.excalidrawAPI.current.updateScene).toHaveBeenCalled();
    });
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("debounces bursts of events into one fetch-and-merge", async () => {
    const getDrawing = vi.fn(async () => ({
      id: "d1",
      elements: [{ id: "e1" }],
      appState: {},
      files: {},
      version: 2,
    }));
    getDrawingImpl = getDrawing;
    const props = buildProps();
    renderHook(() => useEditorCollaboration(props));
    // Fire five events in quick succession.
    emitServerUpdate();
    emitServerUpdate();
    emitServerUpdate();
    emitServerUpdate();
    emitServerUpdate();
    await act(async () => {
      vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
    });
    await vi.waitFor(() => {
      expect(getDrawing).toHaveBeenCalledTimes(1);
    });
  });

  it("merges via updateScene when no local pending edits", async () => {
    const props = buildProps();
    const persisted = [{ id: "e1", version: 1, versionNonce: 1, updated: 1 }];
    props.lastPersistedElementsRef.current = persisted;
    props.latestElementsRef.current = persisted;
    props.currentDrawingVersionRef.current = 1;
    const nextElements = [
      { id: "e1", version: 2, versionNonce: 5, updated: 100 },
      { id: "e2", version: 1, versionNonce: 6, updated: 100 },
    ];
    getDrawingImpl = async () => ({
      id: "d1",
      elements: nextElements,
      appState: { viewBackgroundColor: "#eef" },
      files: { f1: { id: "f1", mimeType: "image/png" } },
      version: 4,
    });
    renderHook(() => useEditorCollaboration(props));
    emitServerUpdate();
    await act(async () => {
      vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
    });
    const updateScene = props.excalidrawAPI.current.updateScene as ReturnType<
      typeof vi.fn
    >;
    const addFiles = props.excalidrawAPI.current.addFiles as ReturnType<
      typeof vi.fn
    >;
    await vi.waitFor(() => {
      expect(updateScene).toHaveBeenCalled();
    });
    const payload = updateScene.mock.calls[0][0];
    expect(payload.elements).toEqual(nextElements);
    expect(payload.appState.viewBackgroundColor).toBe("#eef");
    expect(payload.captureUpdate).toBe("NEVER");
    expect(addFiles).toHaveBeenCalledWith([
      { id: "f1", mimeType: "image/png" },
    ]);
    // Baseline refs updated so subsequent saves target the new version.
    expect(props.currentDrawingVersionRef.current).toBe(4);
    expect(props.latestElementsRef.current).toEqual(nextElements);
    expect(props.lastPersistedElementsRef.current).toEqual(nextElements);
    expect(toastSuccess).toHaveBeenCalledWith("已從 Server 同步最新內容");
  });

  it("does NOT merge when local pending edits are present", async () => {
    const props = buildProps();
    const persisted = [{ id: "e1", version: 1, versionNonce: 1, updated: 1 }];
    props.lastPersistedElementsRef.current = persisted;
    // Local edit — versionNonce differs from persisted.
    props.latestElementsRef.current = [
      { id: "e1", version: 2, versionNonce: 9, updated: 99 },
    ];
    props.currentDrawingVersionRef.current = 1;
    getDrawingImpl = async () => ({
      id: "d1",
      elements: [{ id: "e1", version: 5, versionNonce: 55, updated: 555 }],
      appState: {},
      files: {},
      version: 4,
    });
    renderHook(() => useEditorCollaboration(props));
    emitServerUpdate();
    await act(async () => {
      vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
    });
    await vi.waitFor(() => {
      expect(toastInfo).toHaveBeenCalledWith(
        "Server 有更新、請先儲存你的改動",
      );
    });
    expect(props.excalidrawAPI.current.updateScene).not.toHaveBeenCalled();
    // Version baseline untouched — next save will hit the conflict path.
    expect(props.currentDrawingVersionRef.current).toBe(1);
  });

  it("ignores events for other drawings", async () => {
    const getDrawing = vi.fn(async () => ({
      id: "d1",
      elements: [],
      appState: {},
      files: {},
      version: 2,
    }));
    getDrawingImpl = getDrawing;
    const props = buildProps();
    renderHook(() => useEditorCollaboration(props));
    emitServerUpdate("some-other-drawing");
    await act(async () => {
      vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS + 100);
    });
    expect(getDrawing).not.toHaveBeenCalled();
    expect(props.excalidrawAPI.current.updateScene).not.toHaveBeenCalled();
  });

  it("re-joins the drawing room on socket reconnect", async () => {
    // Regression guard for the "MCP update not delivered to all users" bug.
    // socket.io auto-reconnects after network hiccups (tab suspend, sleep,
    // mobile switch) with a NEW server-side socket.id, dropping the client
    // out of `drawing_${id}`. The hook must re-emit join-room on every
    // connect event so the client rejoins the room and keeps receiving
    // drawing-server-update broadcasts.
    getDrawingImpl = async () => ({
      id: "d1",
      elements: [],
      appState: {},
      files: {},
      version: 1,
    });
    const props = buildProps();
    renderHook(() => useEditorCollaboration(props));
    // Initial mount fires join-room via the socket.connected=true shortcut
    // baked into the fake socket. Grab the count.
    await vi.waitFor(() => {
      const joinCalls = fakeSocket.emit.mock.calls.filter(
        ([evt]: any[]) => evt === "join-room",
      );
      expect(joinCalls.length).toBeGreaterThanOrEqual(1);
    });
    const initialJoinCount = fakeSocket.emit.mock.calls.filter(
      ([evt]: any[]) => evt === "join-room",
    ).length;
    // Simulate socket.io auto-reconnect: the connect handler fires again.
    const connectHandler = socketHandlers.get("connect");
    expect(connectHandler).toBeDefined();
    act(() => {
      connectHandler!();
    });
    // Rejoin must have happened.
    const afterReconnectJoinCount = fakeSocket.emit.mock.calls.filter(
      ([evt]: any[]) => evt === "join-room",
    ).length;
    expect(afterReconnectJoinCount).toBeGreaterThan(initialJoinCount);
    const lastJoinCall = fakeSocket.emit.mock.calls
      .filter(([evt]: any[]) => evt === "join-room")
      .at(-1);
    expect(lastJoinCall?.[1]).toEqual({ drawingId: "d1", user: props.me });
    expect(typeof lastJoinCall?.[2]).toBe("function");
  });

  // BUG-18: after waitForGestureEnd, applying server's elements as a full
  // REPLACE clobbers any local unsaved elements Excalidraw is holding (in-
  // progress element the user was drawing when the broadcast arrived). The
  // apply then triggers a handleCanvasChange with the server-only scene,
  // which resets the debounced-save args to the truncated state, silently
  // losing the user's work. When the server payload is empty (peer clear or
  // MCP delete-all), this manifests as canvas going blank mid-draw. The fix
  // is to MERGE the incoming server elements with Excalidraw's current
  // scene state (same reconciliation the 409 auto-merge uses in
  // resolveVersionConflict), so local unsaved edits survive the apply.
  it("MERGES server elements with local Excalidraw scene so mid-draw unsaved work survives (BUG-18)", async () => {
    const props = buildProps();
    const persisted = [
      { id: "x", version: 1, versionNonce: 1, updated: 1 },
    ];
    props.lastPersistedElementsRef.current = persisted;
    props.latestElementsRef.current = persisted;
    props.currentDrawingVersionRef.current = 1;
    // Simulate Excalidraw's scene containing an in-progress element Z the
    // user is currently drawing — not yet in latestElementsRef because we
    // haven't yielded to the onChange handler between mouse move and the
    // broadcast landing. Version 3 > server's implicit 0 so reconcile keeps it.
    const zLocal = {
      id: "z",
      version: 3,
      versionNonce: 42,
      updated: 500,
      isDeleted: false,
    };
    props.excalidrawAPI.current.getSceneElementsIncludingDeleted = vi.fn(() => [
      persisted[0],
      zLocal,
    ]);
    // Server-fetched state: X (unchanged) + peer's Y. No Z — peer doesn't
    // know about it because our client hasn't autosaved yet.
    const yPeer = {
      id: "y",
      version: 1,
      versionNonce: 50,
      updated: 50,
      isDeleted: false,
    };
    getDrawingImpl = async () => ({
      id: "d1",
      elements: [persisted[0], yPeer],
      appState: {},
      files: {},
      version: 4,
    });
    renderHook(() => useEditorCollaboration(props));
    emitServerUpdate();
    await act(async () => {
      vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
    });
    const updateScene = props.excalidrawAPI.current.updateScene as ReturnType<
      typeof vi.fn
    >;
    await vi.waitFor(() => {
      expect(updateScene).toHaveBeenCalled();
    });
    const payload = updateScene.mock.calls[0][0];
    // Merged scene: x + y (peer) + z (local unsaved).
    const gotIds = (payload.elements as any[])
      .map((e: any) => e.id)
      .sort();
    expect(gotIds).toEqual(["x", "y", "z"]);
    // latestElementsRef captures the merged result so a subsequent
    // handleCanvasChange -> broadcastChanges -> debouncedSave doesn't
    // silently lose Z on the next autosave tick.
    const trackedIds = (props.latestElementsRef.current as any[])
      .map((e: any) => e.id)
      .sort();
    expect(trackedIds).toEqual(["x", "y", "z"]);
    // Server's authoritative baseline still reflects what server sent so
    // the next save can detect drift and trigger the 409 auto-merge.
    const persistedIds = (props.lastPersistedElementsRef.current as any[])
      .map((e: any) => e.id)
      .sort();
    expect(persistedIds).toEqual(["x", "y"]);
    expect(props.currentDrawingVersionRef.current).toBe(4);
  });

  // BUG-18 companion: the reported user symptom. Peer/MCP delete-all fires,
  // server has empty elements, version bumped. User was drawing Z locally.
  // Before the fix: canvas replaced with [] → blank. After the fix: merge
  // preserves Z, canvas shows just Z (peer's delete of others survives).
  it("keeps local unsaved element when server returns empty AND version bumped (BUG-18 blank-canvas repro)", async () => {
    const props = buildProps();
    props.lastPersistedElementsRef.current = [];
    props.latestElementsRef.current = [];
    props.currentDrawingVersionRef.current = 1;
    const zLocal = {
      id: "z",
      version: 2,
      versionNonce: 7,
      updated: 200,
      isDeleted: false,
    };
    props.excalidrawAPI.current.getSceneElementsIncludingDeleted = vi.fn(
      () => [zLocal],
    );
    getDrawingImpl = async () => ({
      id: "d1",
      elements: [],
      appState: {},
      files: {},
      version: 5,
      // no preview — simulating an MCP full-remove that hasn't refreshed preview
    });
    renderHook(() => useEditorCollaboration(props));
    emitServerUpdate();
    await act(async () => {
      vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
    });
    const updateScene = props.excalidrawAPI.current.updateScene as ReturnType<
      typeof vi.fn
    >;
    await vi.waitFor(() => {
      expect(updateScene).toHaveBeenCalled();
    });
    const payload = updateScene.mock.calls[0][0];
    // Local Z survives — canvas NOT blank.
    expect(
      (payload.elements as any[]).map((e: any) => e.id),
    ).toEqual(["z"]);
    // latestElementsRef still contains Z so the next debouncedSave tick
    // won't accidentally save an empty scene.
    expect(
      (props.latestElementsRef.current as any[]).map((e: any) => e.id),
    ).toEqual(["z"]);
  });

  it("defers updateScene while a user gesture is active, then applies", async () => {
    // Regression guard for the MCP-mid-drag crash. When a remote update
    // arrives while the user is dragging/resizing/drawing, applying the
    // new elements array immediately would leave Excalidraw's internal
    // pointerDownState holding stale element refs → crash on next
    // pointermove/pointerup. The hook must hold the apply until the
    // gesture ends.
    const props = buildProps();
    const persisted = [{ id: "e1", version: 1, versionNonce: 1, updated: 1 }];
    props.lastPersistedElementsRef.current = persisted;
    props.latestElementsRef.current = persisted;
    props.currentDrawingVersionRef.current = 1;
    // Simulate a live drag: cursorButton === "down" + selectedElementsAreBeingDragged.
    let simulatedCursor: "up" | "down" = "down";
    props.excalidrawAPI.current.getAppState = vi.fn(() => ({
      collaborators: new Map(),
      cursorButton: simulatedCursor,
      selectedElementsAreBeingDragged: simulatedCursor === "down",
    }));
    getDrawingImpl = async () => ({
      id: "d1",
      elements: [{ id: "e1", version: 9, versionNonce: 9, updated: 9 }],
      appState: {},
      files: {},
      version: 4,
    });
    renderHook(() => useEditorCollaboration(props));
    emitServerUpdate();
    // Advance past debounce. Fetch resolves, but updateScene must NOT
    // fire while the drag is in progress.
    await act(async () => {
      vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS + 50);
    });
    // Yield microtasks so the fetch promise chain runs — up until it hits
    // the waitForGestureEnd rAF poll, which will keep spinning.
    await Promise.resolve();
    await Promise.resolve();
    expect(props.excalidrawAPI.current.updateScene).not.toHaveBeenCalled();
    // End the gesture: cursor up, drag flag clears.
    simulatedCursor = "up";
    // Poll drives the rAF loop; jsdom's rAF fires on next timer tick.
    await act(async () => {
      // Multiple rAF ticks so the poll observes cursor: up.
      vi.advanceTimersByTime(50);
    });
    await vi.waitFor(() => {
      expect(props.excalidrawAPI.current.updateScene).toHaveBeenCalled();
    });
    expect(toastSuccess).toHaveBeenCalledWith("已從 Server 同步最新內容");
  });

  // BUG-15: hard cap the /drawings/:id fetch. If backend hangs, we abort
  // via AbortController after REMOTE_FETCH_TIMEOUT_MS and dismiss the pill.
  it("passes an AbortSignal to getDrawing so a stuck fetch can be aborted", async () => {
    getDrawingImpl = async () => ({
      id: "d1",
      elements: [],
      appState: {},
      files: {},
      version: 2,
    });
    const props = buildProps();
    renderHook(() => useEditorCollaboration(props));
    emitServerUpdate();
    await act(async () => {
      vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
    });
    await vi.waitFor(() => {
      expect(getDrawingSpy).toHaveBeenCalled();
    });
    const [, opts] = getDrawingSpy.mock.calls[0];
    expect(opts).toBeTruthy();
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    // The timeout is real — even after 100ms nothing has fired.
    expect(opts.signal.aborted).toBe(false);
    // Confirm the timeout is exposed and reasonable (guards against
    // accidental 0 / undefined).
    expect(REMOTE_FETCH_TIMEOUT_MS).toBeGreaterThan(1_000);
  });

  it("aborts the getDrawing fetch and dismisses the pill after the hard timeout", async () => {
    // Simulate a hung backend by returning a never-resolving promise until
    // the abort signal fires. This is the real production shape: axios
    // rejects with a CanceledError when the signal aborts.
    getDrawingImpl = async (_id: string, opts?: any) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => {
          const err: any = new Error("aborted");
          err.name = "CanceledError";
          reject(err);
        });
      });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const props = buildProps();
      renderHook(() => useEditorCollaboration(props));
      emitServerUpdate();
      await act(async () => {
        vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
      });
      // Fetch fired.
      await vi.waitFor(() => expect(getDrawingSpy).toHaveBeenCalled());
      // Advance past the hard timeout — the AbortController should fire.
      await act(async () => {
        vi.advanceTimersByTime(REMOTE_FETCH_TIMEOUT_MS + 10);
      });
      // The catch block logs and the finally dismisses the pill (no
      // updateScene, no crash, no toast.success).
      await vi.waitFor(() => {
        expect(warnSpy).toHaveBeenCalled();
      });
      expect(props.excalidrawAPI.current.updateScene).not.toHaveBeenCalled();
      expect(toastSuccess).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // BUG-14 (F1 refined): mirror the suspiciousBlankLoad guard from the scene
  // loader. If backend transiently returns an empty payload while the local
  // scene is non-empty and the server itself advertises a preview AND the
  // version did NOT bump, treat it as suspicious and DO NOT clobber. The
  // version-did-not-bump signal is what tells us this is a transient echo
  // and not an intentional user save.
  it("refuses to clobber a non-empty local scene with an empty remote payload when server advertises a preview AND version did not bump", async () => {
    const props = buildProps();
    const persisted = [{ id: "e1", isDeleted: false }];
    props.lastPersistedElementsRef.current = persisted;
    props.latestElementsRef.current = persisted;
    // Known local version is HIGHER than the response version → guard trips
    // because responseVersion !== knownVersion (skips the equal-early-return)
    // but also responseVersion < knownVersion (versionDidBump = false).
    props.currentDrawingVersionRef.current = 5;
    getDrawingImpl = async () => ({
      id: "d1",
      elements: [],
      appState: {},
      files: {},
      version: 4,
      preview: "data:image/svg+xml;base64,abc",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      renderHook(() => useEditorCollaboration(props));
      emitServerUpdate();
      await act(async () => {
        vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
      });
      await vi.waitFor(() => expect(getDrawingSpy).toHaveBeenCalled());
      // Give the fetch chain a couple of microtasks to settle.
      await Promise.resolve();
      await Promise.resolve();
      expect(props.excalidrawAPI.current.updateScene).not.toHaveBeenCalled();
      expect(toastSuccess).not.toHaveBeenCalled();
      // The warn is the diagnostic breadcrumb.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("suspicious blank"),
        expect.anything(),
      );
      // Local scene untouched.
      expect(props.latestElementsRef.current).toEqual(persisted);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // F1 (Round 3): a legitimate MCP delete-all bumps the server version. If
  // the response reports a strictly greater version than we know locally,
  // treat the empty payload as an intentional write and apply — even if
  // the preview is still present (server hasn't regenerated it yet).
  it("APPLIES an empty remote payload when the server version bumped past the known local version (legitimate delete-all)", async () => {
    const props = buildProps();
    const persisted = [{ id: "e1", isDeleted: false }];
    props.lastPersistedElementsRef.current = persisted;
    props.latestElementsRef.current = persisted;
    props.currentDrawingVersionRef.current = 1;
    getDrawingImpl = async () => ({
      id: "d1",
      elements: [],
      appState: {},
      files: {},
      version: 4, // strictly greater → intentional write
      preview: "data:image/svg+xml;base64,abc",
    });
    renderHook(() => useEditorCollaboration(props));
    emitServerUpdate();
    await act(async () => {
      vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
    });
    await vi.waitFor(() => {
      expect(props.excalidrawAPI.current.updateScene).toHaveBeenCalled();
    });
    // Baseline refs updated so subsequent saves target the new version.
    expect(props.currentDrawingVersionRef.current).toBe(4);
    expect(props.latestElementsRef.current).toEqual([]);
    expect(toastSuccess).toHaveBeenCalledWith("已從 Server 同步最新內容");
  });

  it("allows empty remote payload when local scene is also empty (fresh drawing)", async () => {
    const props = buildProps();
    props.lastPersistedElementsRef.current = [];
    props.latestElementsRef.current = [];
    props.currentDrawingVersionRef.current = 1;
    getDrawingImpl = async () => ({
      id: "d1",
      elements: [],
      appState: {},
      files: {},
      version: 4,
      preview: "data:image/svg+xml;base64,abc",
    });
    renderHook(() => useEditorCollaboration(props));
    emitServerUpdate();
    await act(async () => {
      vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
    });
    await vi.waitFor(() => {
      expect(props.excalidrawAPI.current.updateScene).toHaveBeenCalled();
    });
  });

  it("allows empty remote payload when server did not advertise a preview (real delete-all)", async () => {
    const props = buildProps();
    const persisted = [{ id: "e1", isDeleted: false }];
    props.lastPersistedElementsRef.current = persisted;
    props.latestElementsRef.current = persisted;
    props.currentDrawingVersionRef.current = 1;
    getDrawingImpl = async () => ({
      id: "d1",
      elements: [],
      appState: {},
      files: {},
      version: 4,
      // no preview — legitimate wipe by remote user
    });
    renderHook(() => useEditorCollaboration(props));
    emitServerUpdate();
    await act(async () => {
      vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
    });
    await vi.waitFor(() => {
      expect(props.excalidrawAPI.current.updateScene).toHaveBeenCalled();
    });
  });

  // BUG-13: malformed socket payload must not crash.
  it("ignores a malformed element-update payload (elements: null)", () => {
    const props = buildProps();
    renderHook(() => useEditorCollaboration(props));
    const handler = socketHandlers.get("element-update");
    expect(handler).toBeDefined();
    // These would each throw under the old destructure-only handler.
    expect(() => handler!(null)).not.toThrow();
    expect(() => handler!(undefined)).not.toThrow();
    expect(() => handler!({ elements: null })).not.toThrow();
    expect(() => handler!({ elements: "not-an-array" })).not.toThrow();
    expect(() => handler!({ elements: [{ /* no id */ }] })).not.toThrow();
    expect(() => handler!({ files: [] })).not.toThrow();
    expect(props.excalidrawAPI.current.updateScene).not.toHaveBeenCalled();
  });

  // BUG-9: fetchAndMergeServerUpdate must bail on unmount rather than
  // touching stale refs.
  it("bails out of an in-flight fetch when the hook unmounts", async () => {
    // Never-resolves-until-abort so we can observe unmount behaviour.
    let resolveFetch: ((data: any) => void) | null = null;
    getDrawingImpl = async () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      });
    const props = buildProps();
    const { unmount } = renderHook(() => useEditorCollaboration(props));
    emitServerUpdate();
    await act(async () => {
      vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
    });
    await vi.waitFor(() => expect(getDrawingSpy).toHaveBeenCalled());
    // Unmount MID-flight.
    unmount();
    // Now let the fetch resolve. The continuation past the await must
    // observe the unmount flag and skip everything — no updateScene, no
    // toast, no ref writes.
    resolveFetch!({
      id: "d1",
      elements: [{ id: "e1", isDeleted: false }],
      appState: {},
      files: {},
      version: 99,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(props.excalidrawAPI.current.updateScene).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    // Baseline refs untouched.
    expect(props.currentDrawingVersionRef.current).toBe(1);
  });

  // F4: after MAX_CONSECUTIVE_REMOTE_TIMEOUTS timeouts in a row, further
  // socket-driven fetch attempts are short-circuited so a dead backend can't
  // keep the sync loop grinding. The next successful fetch (or socket
  // reconnect) resets the counter and normal service resumes.
  it("stops firing fetchAndMerge after MAX_CONSECUTIVE_REMOTE_TIMEOUTS in a row (F4)", async () => {
    getDrawingImpl = async (_id: string, opts?: any) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => {
          const err: any = new Error("aborted");
          err.name = "CanceledError";
          reject(err);
        });
      });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const props = buildProps();
      renderHook(() => useEditorCollaboration(props));
      // Trigger MAX consecutive timeouts. Each iteration: emit event →
      // wait for debounce → fetch fires → wait for timeout → catch → finally.
      for (let i = 0; i < MAX_CONSECUTIVE_REMOTE_TIMEOUTS; i++) {
        emitServerUpdate();
        await act(async () => {
          vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
        });
        await vi.waitFor(() => {
          expect(getDrawingSpy).toHaveBeenCalledTimes(i + 1);
        });
        await act(async () => {
          vi.advanceTimersByTime(REMOTE_FETCH_TIMEOUT_MS + 50);
        });
        // Let the catch/finally chain settle.
        await Promise.resolve();
        await Promise.resolve();
      }
      const callsAfterMax = getDrawingSpy.mock.calls.length;
      expect(callsAfterMax).toBe(MAX_CONSECUTIVE_REMOTE_TIMEOUTS);
      // Now emit a fresh event — the counter is at MAX so the fetch is
      // short-circuited before it hits the API.
      emitServerUpdate();
      await act(async () => {
        vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS + 50);
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(getDrawingSpy.mock.calls.length).toBe(callsAfterMax);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("resets the timeout counter on socket reconnect so sync resumes (F4)", async () => {
    // Timeout on the first N-1 attempts, then a socket reconnect resets the
    // counter, and the next successful fetch lands cleanly.
    let shouldTimeout = true;
    getDrawingImpl = async (_id: string, opts?: any) =>
      shouldTimeout
        ? new Promise((_resolve, reject) => {
            opts.signal?.addEventListener("abort", () => {
              const err: any = new Error("aborted");
              err.name = "CanceledError";
              reject(err);
            });
          })
        : Promise.resolve({
            id: "d1",
            elements: [{ id: "e1" }],
            appState: {},
            files: {},
            version: 2,
          });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const props = buildProps();
      renderHook(() => useEditorCollaboration(props));
      // Exhaust the counter to MAX.
      for (let i = 0; i < MAX_CONSECUTIVE_REMOTE_TIMEOUTS; i++) {
        emitServerUpdate();
        await act(async () => {
          vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
        });
        await vi.waitFor(() => {
          expect(getDrawingSpy).toHaveBeenCalledTimes(i + 1);
        });
        await act(async () => {
          vi.advanceTimersByTime(REMOTE_FETCH_TIMEOUT_MS + 50);
        });
        await Promise.resolve();
        await Promise.resolve();
      }
      // Confirm: further events don't fetch.
      emitServerUpdate();
      await act(async () => {
        vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS + 50);
      });
      expect(getDrawingSpy.mock.calls.length).toBe(
        MAX_CONSECUTIVE_REMOTE_TIMEOUTS,
      );
      // Now fire the socket "connect" handler → counter resets to 0.
      const connectHandler = socketHandlers.get("connect");
      expect(connectHandler).toBeDefined();
      act(() => {
        connectHandler!();
      });
      // Also flip the mock to succeed so we exit the timeout regime.
      shouldTimeout = false;
      emitServerUpdate();
      await act(async () => {
        vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
      });
      await vi.waitFor(() => {
        expect(props.excalidrawAPI.current.updateScene).toHaveBeenCalled();
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("exposes the escalation delay as a sane, testable constant", () => {
    // Guards against accidental 0 / undefined that would flash Variant C
    // immediately on every sync.
    expect(REMOTE_SYNC_ESCALATE_MS).toBeGreaterThan(100);
    expect(REMOTE_SYNC_ESCALATE_MS).toBeLessThan(2_000);
  });

  it("skips update when server version matches known version", async () => {
    const props = buildProps();
    props.currentDrawingVersionRef.current = 7;
    getDrawingImpl = async () => ({
      id: "d1",
      elements: [{ id: "e1" }],
      appState: {},
      files: {},
      version: 7,
    });
    renderHook(() => useEditorCollaboration(props));
    emitServerUpdate();
    await act(async () => {
      vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
    });
    // Give the fetch a microtask to settle.
    await vi.waitFor(() => {
      // No merge, no toast.
      expect(toastSuccess).not.toHaveBeenCalled();
    });
    expect(props.excalidrawAPI.current.updateScene).not.toHaveBeenCalled();
  });

  // Origin-based echo suppression (replaces the BUG-17 time-window
  // heuristic). Every scene write fans a drawing-server-update broadcast to
  // the whole room including the sender. The payload now carries the WRITER's
  // origin (saving session id + acting user id), so each recipient decides by
  // EXACT MATCH: own session → skip; own other window → apply silently (no
  // pill); genuine remote / MCP → pill + apply.
  describe("origin-based echo suppression", () => {
    let sessionSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      // Pin this client's session id so tests can craft exact-match / non-match
      // origins deterministically.
      sessionSpy = vi
        .spyOn(diagnostics, "getSessionId")
        .mockReturnValue("sess-self");
    });
    afterEach(() => {
      sessionSpy.mockRestore();
    });

    it("skips entirely (no pill, no fetch) for the client's OWN save echo — originSessionId matches", async () => {
      const props = buildProps();
      renderHook(() => useEditorCollaboration(props));
      // Broadcast originating from THIS session's own save.
      emitServerUpdate({ originSessionId: "sess-self", originUserId: "u1" });
      await act(async () => {
        vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS + 100);
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(getDrawingSpy).not.toHaveBeenCalled();
      expect(props.excalidrawAPI.current.updateScene).not.toHaveBeenCalled();
      expect(toastSuccess).not.toHaveBeenCalled();
    });

    it("applies SILENTLY (fetch + merge, no pill/toast) for the SAME user's OTHER window — originUserId matches, session differs", async () => {
      const props = buildProps({ myUserId: "u1" });
      const persisted = [{ id: "e1", version: 1, versionNonce: 1, updated: 1 }];
      props.lastPersistedElementsRef.current = persisted;
      props.latestElementsRef.current = persisted;
      props.currentDrawingVersionRef.current = 1;
      getDrawingImpl = async () => ({
        id: "d1",
        elements: [{ id: "e1", version: 2, versionNonce: 5, updated: 100 }],
        appState: {},
        files: {},
        version: 4,
      });
      renderHook(() => useEditorCollaboration(props));
      // Same user (u1), but a DIFFERENT session than ours (sess-self).
      emitServerUpdate({ originSessionId: "sess-other-window", originUserId: "u1" });
      await act(async () => {
        vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
      });
      // Content genuinely changed → it IS applied.
      await vi.waitFor(() => {
        expect(props.excalidrawAPI.current.updateScene).toHaveBeenCalled();
      });
      // ...but silently — the success toast (a proxy for the visible sync UI)
      // is suppressed.
      expect(toastSuccess).not.toHaveBeenCalled();
    });

    it("fires pill + applies (toast shown) for a genuine REMOTE user's save — originUserId differs", async () => {
      const props = buildProps({ myUserId: "u1" });
      const persisted = [{ id: "e1", version: 1, versionNonce: 1, updated: 1 }];
      props.lastPersistedElementsRef.current = persisted;
      props.latestElementsRef.current = persisted;
      props.currentDrawingVersionRef.current = 1;
      getDrawingImpl = async () => ({
        id: "d1",
        elements: [{ id: "e1", version: 2, versionNonce: 5, updated: 100 }],
        appState: {},
        files: {},
        version: 4,
      });
      renderHook(() => useEditorCollaboration(props));
      emitServerUpdate({ originSessionId: "sess-peer", originUserId: "someone-else" });
      await act(async () => {
        vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
      });
      await vi.waitFor(() => {
        expect(props.excalidrawAPI.current.updateScene).toHaveBeenCalled();
      });
      expect(toastSuccess).toHaveBeenCalledWith("已從 Server 同步最新內容");
    });

    it("fires pill + applies for an MCP save whose origin has no user id", async () => {
      // An MCP / service write may broadcast with a null originUserId (or one
      // that doesn't match ours). Treated as a genuine remote change.
      const props = buildProps({ myUserId: "u1" });
      const persisted = [{ id: "e1", version: 1, versionNonce: 1, updated: 1 }];
      props.lastPersistedElementsRef.current = persisted;
      props.latestElementsRef.current = persisted;
      props.currentDrawingVersionRef.current = 1;
      getDrawingImpl = async () => ({
        id: "d1",
        elements: [
          { id: "e1", version: 2, versionNonce: 5, updated: 100 },
          { id: "e-mcp", version: 1, versionNonce: 6, updated: 100 },
        ],
        appState: {},
        files: {},
        version: 4,
      });
      renderHook(() => useEditorCollaboration(props));
      emitServerUpdate({ originSessionId: null, originUserId: null });
      await act(async () => {
        vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
      });
      await vi.waitFor(() => {
        expect(props.excalidrawAPI.current.updateScene).toHaveBeenCalled();
      });
      expect(toastSuccess).toHaveBeenCalledWith("已從 Server 同步最新內容");
    });

    it("promotes a coalesced burst to visible when a remote event joins a silent one", async () => {
      // A same-user (silent) event and a genuine remote event debounced into
      // ONE fetch must resolve as visible — the single remote change earns the
      // pill even though the burst started silent.
      const props = buildProps({ myUserId: "u1" });
      const persisted = [{ id: "e1", version: 1, versionNonce: 1, updated: 1 }];
      props.lastPersistedElementsRef.current = persisted;
      props.latestElementsRef.current = persisted;
      props.currentDrawingVersionRef.current = 1;
      getDrawingImpl = async () => ({
        id: "d1",
        elements: [{ id: "e1", version: 2, versionNonce: 5, updated: 100 }],
        appState: {},
        files: {},
        version: 4,
      });
      renderHook(() => useEditorCollaboration(props));
      // Silent event first (same user, other window)...
      emitServerUpdate({ originSessionId: "sess-other-window", originUserId: "u1" });
      // ...then a genuine remote event before the debounce fires.
      emitServerUpdate({ originSessionId: "sess-peer", originUserId: "someone-else" });
      await act(async () => {
        vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
      });
      await vi.waitFor(() => {
        expect(props.excalidrawAPI.current.updateScene).toHaveBeenCalled();
      });
      // Only ONE coalesced fetch, and it was visible.
      expect(getDrawingSpy).toHaveBeenCalledTimes(1);
      expect(toastSuccess).toHaveBeenCalledWith("已從 Server 同步最新內容");
    });

    it("back-fills the acting user id from the drawing GET response (bootstrap: auth context has no user)", async () => {
      // myUserId prop is null (auth-disabled / bootstrap-admin). The first
      // genuine remote fetch learns the acting id from data.requestUserId, so
      // a subsequent same-user broadcast is then recognised and applied
      // silently.
      const props = buildProps({ myUserId: null });
      const persisted = [{ id: "e1", version: 1, versionNonce: 1, updated: 1 }];
      props.lastPersistedElementsRef.current = persisted;
      props.latestElementsRef.current = persisted;
      props.currentDrawingVersionRef.current = 1;
      getDrawingImpl = async () => ({
        id: "d1",
        elements: [{ id: "e1", version: 2, versionNonce: 5, updated: 100 }],
        appState: {},
        files: {},
        version: 4,
        requestUserId: "bootstrap-admin",
      });
      renderHook(() => useEditorCollaboration(props));
      // First event (unknown origin) → visible fetch that back-fills the id.
      emitServerUpdate({ originSessionId: "sess-peer", originUserId: "bootstrap-admin" });
      await act(async () => {
        vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
      });
      await vi.waitFor(() => {
        expect(props.excalidrawAPI.current.updateScene).toHaveBeenCalled();
      });
      // The first one shows the toast (id wasn't known yet).
      expect(toastSuccess).toHaveBeenCalledTimes(1);
      // Advance the version so the second fetch is not an early no-op.
      props.currentDrawingVersionRef.current = 4;
      getDrawingImpl = async () => ({
        id: "d1",
        elements: [{ id: "e1", version: 3, versionNonce: 9, updated: 200 }],
        appState: {},
        files: {},
        version: 5,
        requestUserId: "bootstrap-admin",
      });
      toastSuccess.mockClear();
      // Second event from the SAME user's other window — now recognised, so
      // applied silently (no additional toast).
      emitServerUpdate({ originSessionId: "sess-other-window", originUserId: "bootstrap-admin" });
      await act(async () => {
        vi.advanceTimersByTime(SERVER_UPDATE_DEBOUNCE_MS);
      });
      await vi.waitFor(() => {
        expect(getDrawingSpy).toHaveBeenCalledTimes(2);
      });
      expect(toastSuccess).not.toHaveBeenCalled();
    });
  });
});

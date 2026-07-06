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

// Drawing fetch. Each test rebinds `getDrawingImpl`.
let getDrawingImpl: (id: string) => Promise<any> = async () => ({});
vi.mock("../../api", () => ({
  getDrawing: (id: string) => getDrawingImpl(id),
  // Passthrough — the hook doesn't use these but the module barrel re-exports.
  getLibrary: vi.fn(async () => []),
  isAxiosError: vi.fn(() => false),
}));

// -------------------------------------------------------------------------
import {
  useEditorCollaboration,
  SERVER_UPDATE_DEBOUNCE_MS,
} from "./useEditorCollaboration";

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
    computeElementOrderSig: (els: readonly any[]) =>
      els.map((e: any) => e.id).join(","),
    recordElementVersion: vi.fn(),
    onAccessDenied: vi.fn(),
    ...overrides,
  };
};

// Fires the socket event exactly like the backend does.
const emitServerUpdate = (drawingId = "d1") => {
  const handler = socketHandlers.get("drawing-server-update");
  if (!handler) throw new Error("drawing-server-update handler not registered");
  handler({ drawingId });
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
});

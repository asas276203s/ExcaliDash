import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorSceneLoader } from "./useEditorSceneLoader";
import { clearSceneCache } from "./sceneCache";

// Mock the api layer so we can drive the getDrawing promise resolution
// order ourselves. This is the whole point of the test: prove that the
// scene loader discards a late-arriving fetch when the id has already
// moved on.
vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    getDrawing: vi.fn(),
    getLibrary: vi.fn(async () => []),
    isAxiosError: vi.fn(() => false),
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
import * as api from "../../api";

const makeRefs = () => ({
  elementVersionMap: { current: new Map() },
  saveQueue: { current: Promise.resolve() },
  latestElements: { current: [] as readonly any[] },
  initialSceneElements: { current: [] as readonly any[] },
  latestFiles: { current: {} as any },
  lastSyncedFiles: { current: {} as Record<string, any> },
  lastSyncedElementOrderSig: { current: "" },
  lastPersistedFiles: { current: {} as Record<string, any> },
  currentDrawingVersion: { current: null as number | null },
  lastPersistedElements: { current: [] as readonly any[] },
  suspiciousBlankLoad: { current: false },
  hasSceneChangesSinceLoad: { current: false },
  excalidrawAPI: { current: null as any },
  latestAppState: { current: null as any },
  isBootstrappingScene: { current: true },
  hasHydratedInitialScene: { current: false },
  isSyncing: { current: false },
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
};
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("useEditorSceneLoader race guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Isolate the module-level scene cache between tests so a fetch in one
    // test can't warm-start the next.
    clearSceneCache();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("discards a late-arriving fetch when the drawing id has moved on", async () => {
    const setInitialData = vi.fn();
    const setDrawingName = vi.fn();
    const setAccessLevel = vi.fn();
    const setIsReady = vi.fn();
    const setIsSceneLoading = vi.fn();
    const setLoadError = vi.fn();
    const recordElementVersion = vi.fn();
    const navigate = vi.fn();
    const refs = makeRefs();

    const drawingADeferred = deferred<any>();
    const drawingBDeferred = deferred<any>();

    const getDrawingMock = vi.mocked(api.getDrawing);
    getDrawingMock.mockImplementation((id: string) => {
      if (id === "drawing-a") return drawingADeferred.promise;
      if (id === "drawing-b") return drawingBDeferred.promise;
      throw new Error(`Unexpected id: ${id}`);
    });

    const initialProps = {
      id: "drawing-a" as string | undefined,
      user: { id: "u1" },
      location: { pathname: "/editor/drawing-a", search: "", hash: "" },
      navigate: navigate as any,
      refs,
      setAccessLevel,
      setDrawingName,
      setInitialData,
      setIsReady,
      setIsSceneLoading,
      setLoadError,
      recordElementVersion,
    };

    const { rerender } = renderHook((props: typeof initialProps) =>
      useEditorSceneLoader(props)
    , { initialProps });

    // Kick to tab B before A's fetch resolves — simulates the user
    // clicking tab 2 while tab 1 is still loading.
    rerender({
      ...initialProps,
      id: "drawing-b",
      location: { pathname: "/editor/drawing-b", search: "", hash: "" },
    });

    // Now resolve tab A LAST — the race condition the user reported.
    await act(async () => {
      drawingADeferred.resolve({
        name: "Drawing A",
        elements: [{ id: "a-el-1", type: "rectangle", version: 1 }],
        files: { "a-file-1": { id: "a-file-1" } },
        appState: {},
        accessLevel: "owner",
        version: 5,
      });
      await Promise.resolve();
    });

    // A's data must NOT have been applied — it was superseded by B's run.
    // Look for any setInitialData call whose payload contains an A element:
    const initialDataCalls = setInitialData.mock.calls;
    const anyAPayload = initialDataCalls.some((call) => {
      const arg = call[0];
      if (!arg || !Array.isArray(arg.elements)) return false;
      return arg.elements.some((el: any) => el?.id === "a-el-1");
    });
    expect(anyAPayload).toBe(false);

    // The drawingName must NOT have been set to A after the swap.
    expect(setDrawingName).not.toHaveBeenCalledWith("Drawing A");

    // Refs must not carry A's elements/files (would leak into save).
    expect(refs.latestElements.current).not.toContain(
      expect.objectContaining({ id: "a-el-1" })
    );
    expect(refs.latestFiles.current).not.toHaveProperty("a-file-1");

    // Now resolve B — it IS the current run, its data SHOULD apply.
    await act(async () => {
      drawingBDeferred.resolve({
        name: "Drawing B",
        elements: [{ id: "b-el-1", type: "ellipse", version: 1 }],
        files: {},
        appState: {},
        accessLevel: "owner",
        version: 2,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(setDrawingName).toHaveBeenCalledWith("Drawing B");
    });
    const anyBPayload = setInitialData.mock.calls.some((call) => {
      const arg = call[0];
      if (!arg || !Array.isArray(arg.elements)) return false;
      return arg.elements.some((el: any) => el?.id === "b-el-1");
    });
    expect(anyBPayload).toBe(true);
    expect(refs.currentDrawingVersion.current).toBe(2);
  });

  it("discards a late-arriving fetch ERROR when the drawing id has moved on", async () => {
    const setInitialData = vi.fn();
    const setLoadError = vi.fn();
    const setIsSceneLoading = vi.fn();
    const refs = makeRefs();

    const drawingADeferred = deferred<any>();
    const drawingBDeferred = deferred<any>();

    const getDrawingMock = vi.mocked(api.getDrawing);
    getDrawingMock.mockImplementation((id: string) => {
      if (id === "drawing-a") return drawingADeferred.promise;
      if (id === "drawing-b") return drawingBDeferred.promise;
      throw new Error(`Unexpected id: ${id}`);
    });

    const initialProps = {
      id: "drawing-a" as string | undefined,
      user: { id: "u1" },
      location: { pathname: "/editor/drawing-a", search: "", hash: "" },
      navigate: vi.fn() as any,
      refs,
      setAccessLevel: vi.fn(),
      setDrawingName: vi.fn(),
      setInitialData,
      setIsReady: vi.fn(),
      setIsSceneLoading,
      setLoadError,
      recordElementVersion: vi.fn(),
    };

    const { rerender } = renderHook((props: typeof initialProps) =>
      useEditorSceneLoader(props)
    , { initialProps });

    // Switch to B before A resolves.
    rerender({
      ...initialProps,
      id: "drawing-b",
      location: { pathname: "/editor/drawing-b", search: "", hash: "" },
    });

    // A's fetch fails LATE — must not raise a toast about A or set
    // loadError on B's screen.
    await act(async () => {
      drawingADeferred.reject(new Error("fetch A failed after switch"));
      await Promise.resolve();
    });

    expect(setLoadError).not.toHaveBeenCalledWith("Failed to load drawing");

    // Resolve B — user's active tab. Loading should complete for B.
    await act(async () => {
      drawingBDeferred.resolve({
        name: "Drawing B",
        elements: [],
        files: {},
        appState: {},
        accessLevel: "owner",
        version: 1,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      // Expect at least one call setting sceneLoading to false — B loaded.
      expect(setIsSceneLoading).toHaveBeenCalledWith(false);
    });
  });
});

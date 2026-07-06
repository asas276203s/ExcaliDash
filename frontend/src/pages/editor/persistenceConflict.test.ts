import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";

// --- Module mocks --------------------------------------------------------
const toastInfo = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    info: (...args: any[]) => toastInfo(...args),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

let getDrawingImpl: (id: string) => Promise<any> = async () => ({});
vi.mock("../../api", () => ({
  getDrawing: (id: string) => getDrawingImpl(id),
  isAxiosError: (v: any) => Boolean(v?.__axios),
}));

import {
  DrawingSaveConflictError,
  resolveVersionConflict,
} from "./persistenceConflict";

const makeRef = <T>(value: T): MutableRefObject<T> => ({ current: value });

const buildRefs = () => ({
  currentDrawingVersion: makeRef<number | null>(3),
  excalidrawAPI: makeRef<any>({
    updateScene: vi.fn(),
    addFiles: vi.fn(),
  }),
  isSyncing: makeRef(false),
  latestElements: makeRef<readonly any[]>([]),
  latestFiles: makeRef<any>({}),
  lastPersistedElements: makeRef<readonly any[]>([]),
  lastPersistedFiles: makeRef<Record<string, any>>({}),
  lastSyncedFiles: makeRef<Record<string, any>>({}),
});

const build409Error = (currentVersion: number | null = 5) => ({
  __axios: true,
  response: {
    status: 409,
    data: { code: "VERSION_CONFLICT", currentVersion },
  },
});

const el = (id: string, version = 1) => ({
  id,
  type: "rectangle",
  version,
  versionNonce: version * 10,
  updated: version,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
});

describe("resolveVersionConflict", () => {
  beforeEach(() => {
    toastInfo.mockReset();
    getDrawingImpl = async () => ({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("merges local + fresh, applies to canvas, bumps version, toasts undo", async () => {
    const refs = buildRefs();
    const local = [el("a", 5), el("b", 1)];
    // Fresh: MCP added element `c`, kept `a` at v2 (older than local's v5).
    getDrawingImpl = async () => ({
      version: 6,
      elements: [el("a", 2), el("c", 1)],
      files: { f1: { id: "f1" } },
    });

    const result = await resolveVersionConflict({
      drawingId: "d1",
      err: build409Error(6),
      refs,
      localSnapshotElements: local,
      localSnapshotFiles: { f2: { id: "f2" } },
      persistableAppState: { viewBackgroundColor: "#fff" },
    });

    // Merged: local a@5 wins over remote a@2; b (local-only) kept; c (remote-only) adopted.
    const mergedIds = result.merged.map((e: any) => e.id).sort();
    expect(mergedIds).toEqual(["a", "b", "c"]);
    expect(result.merged.find((e: any) => e.id === "a").version).toBe(5);

    // Files merged: fresh + local.
    expect(Object.keys(result.mergedFiles).sort()).toEqual(["f1", "f2"]);

    // Canvas updated.
    expect(refs.excalidrawAPI.current.updateScene).toHaveBeenCalledTimes(1);
    expect(refs.excalidrawAPI.current.addFiles).toHaveBeenCalledTimes(1);

    // Version advanced.
    expect(refs.currentDrawingVersion.current).toBe(6);

    // Baseline set to fresh (server view), latest set to merged (next-save target).
    expect(refs.lastPersistedElements.current.map((e: any) => e.id).sort()).toEqual(
      ["a", "c"],
    );
    expect(refs.latestElements.current.map((e: any) => e.id).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);

    // Toast fired with undo action.
    expect(toastInfo).toHaveBeenCalledTimes(1);
    const [msg, opts] = toastInfo.mock.calls[0];
    expect(String(msg)).toMatch(/合併|同步/);
    expect(opts.action?.label).toBe("復原");

    // Invoking undo restores local snapshot.
    opts.action.onClick();
    expect(refs.excalidrawAPI.current.updateScene).toHaveBeenCalledTimes(2);
    expect(refs.latestElements.current.map((e: any) => e.id).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("throws DrawingSaveConflictError when getDrawing fails", async () => {
    const refs = buildRefs();
    getDrawingImpl = async () => {
      throw new Error("network");
    };
    await expect(
      resolveVersionConflict({
        drawingId: "d1",
        err: build409Error(7),
        refs,
        localSnapshotElements: [],
        localSnapshotFiles: {},
        persistableAppState: {},
      }),
    ).rejects.toBeInstanceOf(DrawingSaveConflictError);
    // Version ref adopts server-reported number even in fallback.
    expect(refs.currentDrawingVersion.current).toBe(7);
  });

  it("re-throws non-409 errors unchanged", async () => {
    const refs = buildRefs();
    const err = { __axios: true, response: { status: 500 } };
    await expect(
      resolveVersionConflict({
        drawingId: "d1",
        err,
        refs,
        localSnapshotElements: [],
        localSnapshotFiles: {},
        persistableAppState: {},
      }),
    ).rejects.toBe(err);
  });
});

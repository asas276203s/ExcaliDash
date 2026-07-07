import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("axios", () => {
  const post = vi.fn(() => Promise.resolve({ data: { ok: true, id: "r1" } }));
  return { default: { post }, post };
});

import axios from "axios";
import {
  diagnostics,
  hasErrorSince,
  isBlankCanvasState,
  pushRingBuffer,
  RING_BUFFER_MAX,
  type DiagEntry,
} from "./diagnostics";

const mockedPost = axios.post as unknown as ReturnType<typeof vi.fn>;

const makeEntry = (over: Partial<DiagEntry> = {}): DiagEntry => ({
  ts: over.ts ?? Date.now(),
  sessionId: "sess-1",
  drawingId: over.drawingId ?? null,
  appVersion: "test",
  level: over.level ?? "info",
  type: over.type ?? "unit",
  payload: over.payload,
});

describe("pushRingBuffer", () => {
  it("appends without exceeding max and drops the oldest", () => {
    let buf: DiagEntry[] = [];
    for (let i = 0; i < RING_BUFFER_MAX + 25; i++) {
      buf = pushRingBuffer(buf, makeEntry({ type: `e${i}`, ts: i }));
    }
    expect(buf.length).toBe(RING_BUFFER_MAX);
    // Oldest 25 dropped → first surviving entry is e25.
    expect(buf[0].type).toBe("e25");
    expect(buf[buf.length - 1].type).toBe(`e${RING_BUFFER_MAX + 24}`);
  });

  it("returns a new array (immutability)", () => {
    const a: DiagEntry[] = [];
    const b = pushRingBuffer(a, makeEntry());
    expect(b).not.toBe(a);
    expect(a.length).toBe(0);
    expect(b.length).toBe(1);
  });
});

describe("isBlankCanvasState", () => {
  it("flags zero rendered elements while the tracker holds content", () => {
    expect(isBlankCanvasState(0, 5)).toBe(true);
  });
  it("does not flag a legitimately empty scene", () => {
    expect(isBlankCanvasState(0, 0)).toBe(false);
  });
  it("does not flag a populated scene", () => {
    expect(isBlankCanvasState(3, 5)).toBe(false);
  });
});

describe("hasErrorSince", () => {
  const buf: DiagEntry[] = [
    makeEntry({ level: "info", ts: 10 }),
    makeEntry({ level: "error", ts: 20 }),
  ];
  it("is true when an error entry is newer than the cutoff", () => {
    expect(hasErrorSince(buf, 15)).toBe(true);
  });
  it("is false when the only error predates the cutoff", () => {
    expect(hasErrorSince(buf, 25)).toBe(false);
  });
  it("is false when there are no error entries", () => {
    expect(hasErrorSince([makeEntry({ level: "info", ts: 30 })], 0)).toBe(false);
  });
});

describe("diagnostics singleton", () => {
  beforeEach(() => {
    mockedPost.mockClear();
    mockedPost.mockResolvedValue({ data: { ok: true, id: "r1" } });
  });

  afterEach(async () => {
    // Drain any buffered entries so tests don't leak state into each other.
    await diagnostics.flush("test-cleanup").catch(() => undefined);
  });

  it("records entries in the buffer", () => {
    const before = diagnostics.getBufferSnapshot().length;
    diagnostics.log("unit-event", { a: 1 });
    const after = diagnostics.getBufferSnapshot();
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1].type).toBe("unit-event");
  });

  it("flushes buffered entries to the backend and clears them", async () => {
    diagnostics.log("to-flush", { b: 2 });
    expect(diagnostics.getBufferSnapshot().length).toBeGreaterThan(0);
    const ok = await diagnostics.flush("manual");
    expect(ok).toBe(true);
    expect(mockedPost).toHaveBeenCalledTimes(1);
    const [url, body, opts] = mockedPost.mock.calls[0];
    expect(String(url)).toContain("/diagnostics");
    expect(body.source).toBe("client");
    expect(Array.isArray(body.entries)).toBe(true);
    expect((opts as any).headers["X-Session-Id"]).toBe(
      diagnostics.getSessionId(),
    );
    expect(diagnostics.getBufferSnapshot().length).toBe(0);
  });

  it("does not POST when the buffer is empty", async () => {
    await diagnostics.flush("drain").catch(() => undefined);
    mockedPost.mockClear();
    const ok = await diagnostics.flush("empty");
    expect(ok).toBe(false);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it("retains the buffer when the flush POST fails", async () => {
    diagnostics.log("keep-on-fail");
    mockedPost.mockRejectedValueOnce(new Error("network"));
    const ok = await diagnostics.flush("manual");
    expect(ok).toBe(false);
    expect(diagnostics.getBufferSnapshot().length).toBeGreaterThan(0);
  });
});

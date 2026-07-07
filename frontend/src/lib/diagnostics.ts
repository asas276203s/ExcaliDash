/**
 * Client-side diagnostic logger — the browser half of the ExcaliDash bug
 * tracker.
 *
 * A bounded in-memory ring buffer captures the recent event trace (socket
 * lifecycle, remote-sync pipeline, scene load, saves, and any window / React
 * error). When something goes wrong — an uncaught error, a React
 * ErrorBoundary catch, or the blank-canvas watchdog firing — the buffer is
 * flushed to `POST /api/diagnostics` so an operator can pull the user's
 * ACTUAL trace via `GET /api/diagnostics/recent` and fix from real data
 * instead of guessing.
 *
 * Privacy: only counts, ids, versions and event types are logged — never
 * drawing element payloads.
 *
 * The pure helpers (pushRingBuffer / isBlankCanvasState / hasErrorSince) are
 * exported for unit testing.
 */
import axios from "axios";

export const RING_BUFFER_MAX = 500;
/** Minimum gap between auto (error-triggered) flushes, to avoid flooding. */
export const AUTO_FLUSH_THROTTLE_MS = 5_000;
/** Interval on which we flush if the buffer accrued any error-level entry. */
export const ERROR_FLUSH_INTERVAL_MS = 60_000;

const API_URL = (import.meta as any).env?.VITE_API_URL || "/api";
const SESSION_KEY = "excalidash:diag:session-id";
const BUFFER_KEY = "excalidash:diag:buffer";
const PERSIST_THROTTLE_MS = 2_000;
const PERSIST_MAX_ENTRIES = 200;
const RESTORE_MAX_AGE_MS = 30 * 60 * 1000;

export type DiagLevel = "info" | "warn" | "error";

export interface DiagEntry {
  ts: number;
  sessionId: string;
  drawingId: string | null;
  appVersion: string;
  level: DiagLevel;
  type: string;
  payload?: Record<string, unknown>;
}

// --- Pure helpers (unit-tested) ------------------------------------------

/** Append `entry`, keeping at most `max` newest entries. Returns a new array. */
export function pushRingBuffer(
  buffer: readonly DiagEntry[],
  entry: DiagEntry,
  max: number = RING_BUFFER_MAX,
): DiagEntry[] {
  const next =
    buffer.length >= max
      ? buffer.slice(buffer.length - max + 1)
      : buffer.slice();
  next.push(entry);
  return next;
}

/**
 * Blank-canvas signature: Excalidraw reports zero rendered elements while our
 * own element tracker still holds content — a state divergence that matches
 * the "白屏" symptom.
 */
export function isBlankCanvasState(
  sceneElementCount: number,
  trackedElementCount: number,
): boolean {
  return sceneElementCount === 0 && trackedElementCount > 0;
}

/** True if any error-level entry was recorded strictly after `sinceTs`. */
export function hasErrorSince(
  buffer: readonly DiagEntry[],
  sinceTs: number,
): boolean {
  return buffer.some((e) => e.level === "error" && e.ts > sinceTs);
}

// --- Environment guards ---------------------------------------------------

const isBrowser = typeof window !== "undefined";

const readSessionId = (): string => {
  const gen = () => {
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
      }
    } catch {
      /* fall through */
    }
    return `sid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  };
  if (!isBrowser) return gen();
  try {
    const existing = window.sessionStorage?.getItem(SESSION_KEY);
    if (existing) return existing;
    const created = gen();
    window.sessionStorage?.setItem(SESSION_KEY, created);
    return created;
  } catch {
    return gen();
  }
};

// --- The singleton logger -------------------------------------------------

class Diagnostics {
  private buffer: DiagEntry[] = [];
  private sessionId: string = readSessionId();
  private drawingId: string | null = null;
  private appVersion = "unknown";
  private installed = false;
  private flushing = false;
  private lastFlushAt = 0;
  private lastAutoFlushAt = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private autoFlushTimer: ReturnType<typeof setTimeout> | null = null;

  getSessionId(): string {
    return this.sessionId;
  }

  setDrawingId(id: string | null | undefined): void {
    this.drawingId = id ?? null;
  }

  setAppVersion(version: string | null | undefined): void {
    if (typeof version === "string" && version.trim().length > 0) {
      this.appVersion = version.trim();
    }
  }

  getBufferSnapshot(): DiagEntry[] {
    return this.buffer.slice();
  }

  /** Record one event. Cheap and synchronous; never throws. */
  log(
    type: string,
    payload?: Record<string, unknown>,
    level: DiagLevel = "info",
  ): void {
    try {
      const entry: DiagEntry = {
        ts: Date.now(),
        sessionId: this.sessionId,
        drawingId: this.drawingId,
        appVersion: this.appVersion,
        level,
        type,
        payload,
      };
      this.buffer = pushRingBuffer(this.buffer, entry);
      this.schedulePersist();
    } catch {
      /* diagnostics must never break the app */
    }
  }

  /** Install global error hooks + the periodic error-flush timer (idempotent). */
  install(): void {
    if (this.installed || !isBrowser) return;
    this.installed = true;
    this.restoreBuffer();

    window.addEventListener("error", (event: ErrorEvent) => {
      this.log(
        "window-error",
        {
          message: event.message,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          stack: event.error?.stack ?? null,
        },
        "error",
      );
      this.scheduleAutoFlush();
    });

    window.addEventListener(
      "unhandledrejection",
      (event: PromiseRejectionEvent) => {
        const reason: any = event.reason;
        this.log(
          "unhandled-rejection",
          {
            message:
              typeof reason?.message === "string"
                ? reason.message
                : String(reason),
            stack: reason?.stack ?? null,
          },
          "error",
        );
        this.scheduleAutoFlush();
      },
    );

    const interval = setInterval(() => {
      if (hasErrorSince(this.buffer, this.lastFlushAt)) {
        void this.flush("interval");
      }
    }, ERROR_FLUSH_INTERVAL_MS);
    if (typeof (interval as any).unref === "function") {
      (interval as any).unref();
    }

    // Last-ditch flush when the tab goes away, so an in-progress error trace
    // isn't lost on navigation / close.
    window.addEventListener("pagehide", () => {
      if (this.buffer.length > 0) void this.flush("pagehide");
    });
  }

  /**
   * Send the current buffer to the backend. On success the buffer is cleared
   * (the batch is now persisted server-side); on failure it is retained for
   * the next attempt. Never throws.
   */
  async flush(reason: string): Promise<boolean> {
    if (!isBrowser) return false;
    if (this.flushing) return false;
    const entries = this.buffer.slice();
    if (entries.length === 0) return false;
    this.flushing = true;
    this.lastFlushAt = Date.now();
    this.lastAutoFlushAt = Date.now();
    try {
      await axios.post(
        `${API_URL}/diagnostics`,
        {
          source: "client",
          sessionId: this.sessionId,
          drawingId: this.drawingId,
          appVersion: this.appVersion,
          reason,
          entries,
        },
        {
          withCredentials: true,
          headers: { "X-Session-Id": this.sessionId },
          timeout: 8_000,
        },
      );
      // Drop the flushed batch but keep anything logged during the request.
      this.buffer = this.buffer.slice(entries.length);
      this.persistNow();
      return true;
    } catch {
      return false;
    } finally {
      this.flushing = false;
    }
  }

  private scheduleAutoFlush(): void {
    const now = Date.now();
    const elapsed = now - this.lastAutoFlushAt;
    if (elapsed >= AUTO_FLUSH_THROTTLE_MS) {
      void this.flush("auto");
      return;
    }
    if (this.autoFlushTimer) return;
    this.autoFlushTimer = setTimeout(() => {
      this.autoFlushTimer = null;
      void this.flush("auto");
    }, AUTO_FLUSH_THROTTLE_MS - elapsed);
  }

  private schedulePersist(): void {
    if (!isBrowser || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, PERSIST_THROTTLE_MS);
  }

  private persistNow(): void {
    if (!isBrowser) return;
    try {
      const entries = this.buffer.slice(-PERSIST_MAX_ENTRIES);
      window.localStorage?.setItem(
        BUFFER_KEY,
        JSON.stringify({
          sessionId: this.sessionId,
          savedAt: Date.now(),
          entries,
        }),
      );
    } catch {
      /* quota / privacy mode — ignore */
    }
  }

  private restoreBuffer(): void {
    if (!isBrowser) return;
    try {
      const raw = window.localStorage?.getItem(BUFFER_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        sessionId?: string;
        savedAt?: number;
        entries?: DiagEntry[];
      };
      if (
        parsed.sessionId === this.sessionId &&
        Array.isArray(parsed.entries) &&
        typeof parsed.savedAt === "number" &&
        Date.now() - parsed.savedAt < RESTORE_MAX_AGE_MS
      ) {
        this.buffer = parsed.entries.slice(-RING_BUFFER_MAX);
      }
    } catch {
      /* ignore corrupt persisted buffer */
    }
  }
}

export const diagnostics = new Diagnostics();

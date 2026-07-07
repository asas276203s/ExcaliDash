/**
 * Diagnostics store — the server-side half of the ExcaliDash bug tracker.
 *
 * Two append-only tables with bounded retention:
 *   - ServerLog:        structured server events (requests, errors, socket
 *                       lifecycle, drawing-save version deltas).
 *   - DiagnosticReport: batched client ring-buffer flushes plus (optionally)
 *                       server-side report batches.
 *
 * Design rules:
 *   - EVERY write is best-effort. Telemetry must NEVER crash a request, a
 *     socket handler, or the error middleware. All writes are wrapped and
 *     swallow their own failures.
 *   - No drawing element payloads are stored — only counts / ids / event
 *     types (privacy + size).
 *   - Uses the singleton Prisma client so callers don't have to thread deps.
 */
import { prisma } from "../db/prisma";

export type ServerLogLevel = "info" | "warn" | "error";

export interface ServerLogInput {
  level?: ServerLogLevel;
  type: string;
  sessionId?: string | null;
  drawingId?: string | null;
  requestId?: string | null;
  route?: string | null;
  method?: string | null;
  status?: number | null;
  durationMs?: number | null;
  message?: string | null;
  payload?: unknown;
}

/** Keep the newest N server logs; older rows are pruned in batches. */
export const SERVER_LOG_RETENTION = 5000;
/** Keep the newest N client/server diagnostic report batches. */
export const CLIENT_REPORT_RETENTION = 200;

const MAX_MESSAGE_LEN = 2000;
const MAX_PAYLOAD_LEN = 20_000;

const truncate = (value: string | null | undefined, max: number): string | null => {
  if (typeof value !== "string") return null;
  return value.length > max ? value.slice(0, max) : value;
};

const serializePayload = (payload: unknown): string | null => {
  if (payload === undefined || payload === null) return null;
  try {
    const json = JSON.stringify(payload);
    return truncate(json, MAX_PAYLOAD_LEN);
  } catch {
    return null;
  }
};

/**
 * Record one structured server-side event. Best-effort — never throws.
 * Fire-and-forget from the caller's perspective (returns a promise you can
 * ignore).
 */
export async function recordServerLog(input: ServerLogInput): Promise<void> {
  try {
    await prisma.serverLog.create({
      data: {
        level: input.level ?? "info",
        type: input.type,
        sessionId: input.sessionId ?? null,
        drawingId: input.drawingId ?? null,
        requestId: input.requestId ?? null,
        route: truncate(input.route ?? null, 512),
        method: input.method ?? null,
        status: input.status ?? null,
        durationMs: input.durationMs ?? null,
        message: truncate(input.message ?? null, MAX_MESSAGE_LEN),
        payload: serializePayload(input.payload),
      },
    });
  } catch (err) {
    // Telemetry must never break the caller. Log to stderr in dev only.
    if (process.env.NODE_ENV === "development") {
      console.warn("[diagnostics] recordServerLog failed:", err);
    }
  }
}

export interface DiagnosticReportInput {
  source?: string;
  sessionId?: string | null;
  drawingId?: string | null;
  appVersion?: string | null;
  userId?: string | null;
  userAgent?: string | null;
  entries: unknown;
}

/**
 * Persist a batch of client (or server) ring-buffer entries. Best-effort.
 * Returns the created id, or null on failure.
 */
export async function recordDiagnosticReport(
  input: DiagnosticReportInput,
): Promise<string | null> {
  try {
    const entriesArray = Array.isArray(input.entries) ? input.entries : [];
    const entriesJson = truncate(
      JSON.stringify(entriesArray),
      2_000_000, // hard cap ~2MB to stop a runaway buffer filling the DB
    );
    const created = await prisma.diagnosticReport.create({
      data: {
        source: input.source ?? "client",
        sessionId: input.sessionId ?? null,
        drawingId: input.drawingId ?? null,
        appVersion: truncate(input.appVersion ?? null, 256),
        userId: input.userId ?? null,
        userAgent: truncate(input.userAgent ?? null, 512),
        entries: entriesJson ?? "[]",
        entryCount: entriesArray.length,
      },
      select: { id: true },
    });
    return created.id;
  } catch (err) {
    if (process.env.NODE_ENV === "development") {
      console.warn("[diagnostics] recordDiagnosticReport failed:", err);
    }
    return null;
  }
}

/**
 * Prune both telemetry tables down to their retention caps. Best-effort;
 * called on an interval from the route registrar.
 */
export async function cleanupDiagnostics(): Promise<void> {
  await pruneTable("serverLog", SERVER_LOG_RETENTION);
  await pruneTable("diagnosticReport", CLIENT_REPORT_RETENTION);
}

async function pruneTable(
  table: "serverLog" | "diagnosticReport",
  keep: number,
): Promise<void> {
  try {
    const total = await (prisma as any)[table].count();
    if (total <= keep) return;
    // Find the createdAt boundary of the newest `keep` rows, delete older.
    const boundary = await (prisma as any)[table].findMany({
      orderBy: { createdAt: "desc" },
      skip: keep - 1,
      take: 1,
      select: { createdAt: true },
    });
    const cutoff = boundary?.[0]?.createdAt;
    if (!cutoff) return;
    await (prisma as any)[table].deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
  } catch (err) {
    if (process.env.NODE_ENV === "development") {
      console.warn(`[diagnostics] prune ${table} failed:`, err);
    }
  }
}

/** Extract the correlation session id a client attaches to every request. */
export function getSessionIdFromHeaders(headers: {
  [key: string]: string | string[] | undefined;
}): string | null {
  const raw = headers["x-session-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 200);
  return trimmed.length > 0 ? trimmed : null;
}

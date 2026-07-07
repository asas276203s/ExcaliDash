/**
 * Diagnostics ingestion + retrieval routes — the operator-facing side of the
 * ExcaliDash bug tracker.
 *
 *   POST /diagnostics            — client ring-buffer flush (no auth; a user
 *                                  hitting a blank canvas may be an anonymous
 *                                  share-link viewer). Rate-limited + capped.
 *   GET  /diagnostics/recent     — operator query (requireAuth), returns
 *                                  client reports AND/OR server logs merged on
 *                                  a time axis, filterable by source /
 *                                  sessionId / drawingId / since.
 *
 * The POST endpoint is intentionally mounted BEFORE the CSRF middleware in
 * index.ts so a diagnostic flush survives even when the SPA is in a broken
 * state and has no fresh CSRF token — losing the trace defeats the purpose.
 */
import type { Express, Request, Response, NextFunction, RequestHandler } from "express";
import { prisma } from "../db/prisma";
import {
  cleanupDiagnostics,
  getSessionIdFromHeaders,
  recordDiagnosticReport,
} from "../diagnostics/store";

type RegisterDiagnosticsDeps = {
  requireAuth: RequestHandler;
  asyncHandler: <T = void>(
    fn: (req: Request, res: Response, next: NextFunction) => Promise<T>,
  ) => RequestHandler;
};

const MAX_ENTRIES_PER_REPORT = 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes

// Very small in-memory throttle so a wedged client can't hammer ingestion.
const ingestWindow = new Map<string, { count: number; resetAt: number }>();
const INGEST_WINDOW_MS = 60_000;
const INGEST_MAX_PER_WINDOW = 30;

const isIngestAllowed = (key: string): boolean => {
  const now = Date.now();
  const rec = ingestWindow.get(key);
  if (!rec || now > rec.resetAt) {
    ingestWindow.set(key, { count: 1, resetAt: now + INGEST_WINDOW_MS });
    return true;
  }
  if (rec.count >= INGEST_MAX_PER_WINDOW) return false;
  rec.count += 1;
  return true;
};

const parseSince = (value: unknown): Date | null => {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  // Accept both ISO strings and epoch millis.
  const asNumber = Number(value);
  const date = Number.isFinite(asNumber) && value.trim() === String(asNumber)
    ? new Date(asNumber)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const registerDiagnosticsRoutes = (
  app: Express,
  deps: RegisterDiagnosticsDeps,
): void => {
  const { requireAuth, asyncHandler } = deps;

  // --- Ingestion: POST /diagnostics --------------------------------------
  app.post(
    "/diagnostics",
    asyncHandler(async (req: Request, res: Response) => {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const sessionId =
        getSessionIdFromHeaders(req.headers) ||
        (typeof req.body?.sessionId === "string" ? req.body.sessionId : null);
      const throttleKey = sessionId || ip;
      if (!isIngestAllowed(throttleKey)) {
        return res.status(429).json({ ok: false, error: "Too many reports" });
      }

      const body = req.body ?? {};
      const rawEntries = Array.isArray(body.entries) ? body.entries : [];
      const entries = rawEntries.slice(-MAX_ENTRIES_PER_REPORT);

      const id = await recordDiagnosticReport({
        source: body.source === "server" ? "server" : "client",
        sessionId,
        drawingId: typeof body.drawingId === "string" ? body.drawingId : null,
        appVersion: typeof body.appVersion === "string" ? body.appVersion : null,
        userId: req.user?.id ?? null,
        userAgent:
          typeof req.headers["user-agent"] === "string"
            ? req.headers["user-agent"]
            : null,
        entries,
      });

      return res.status(id ? 201 : 202).json({ ok: true, id });
    }),
  );

  // --- Retrieval: GET /diagnostics/recent --------------------------------
  app.get(
    "/diagnostics/recent",
    requireAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const source =
        req.query.source === "client" || req.query.source === "server"
          ? (req.query.source as "client" | "server")
          : null;
      const sessionId =
        typeof req.query.sessionId === "string" ? req.query.sessionId : null;
      const drawingId =
        typeof req.query.drawingId === "string" ? req.query.drawingId : null;
      const since = parseSince(req.query.since);
      const limit = Math.min(
        Math.max(Number(req.query.limit) || 20, 1),
        200,
      );

      const createdAtFilter = since ? { gte: since } : undefined;

      // Client (and server-batched) reports.
      const wantReports = source !== "server";
      // Structured server logs.
      const wantServerLogs = source !== "client";

      const [reports, serverLogs] = await Promise.all([
        wantReports
          ? prisma.diagnosticReport.findMany({
              where: {
                ...(source === "client" ? { source: "client" } : {}),
                ...(sessionId ? { sessionId } : {}),
                ...(drawingId ? { drawingId } : {}),
                ...(createdAtFilter ? { createdAt: createdAtFilter } : {}),
              },
              orderBy: { createdAt: "desc" },
              take: limit,
            })
          : Promise.resolve([]),
        wantServerLogs
          ? prisma.serverLog.findMany({
              where: {
                ...(sessionId ? { sessionId } : {}),
                ...(drawingId ? { drawingId } : {}),
                ...(createdAtFilter ? { createdAt: createdAtFilter } : {}),
              },
              orderBy: { createdAt: "desc" },
              take: limit,
            })
          : Promise.resolve([]),
      ]);

      const reportItems = reports.map((r) => ({
        kind: "report" as const,
        id: r.id,
        source: r.source,
        sessionId: r.sessionId,
        drawingId: r.drawingId,
        appVersion: r.appVersion,
        userId: r.userId,
        userAgent: r.userAgent,
        entryCount: r.entryCount,
        entries: safeParse(r.entries),
        createdAt: r.createdAt,
      }));

      const serverItems = serverLogs.map((s) => ({
        kind: "server-log" as const,
        id: s.id,
        level: s.level,
        type: s.type,
        sessionId: s.sessionId,
        drawingId: s.drawingId,
        requestId: s.requestId,
        route: s.route,
        method: s.method,
        status: s.status,
        durationMs: s.durationMs,
        message: s.message,
        payload: s.payload ? safeParse(s.payload) : null,
        createdAt: s.createdAt,
      }));

      const items = [...reportItems, ...serverItems].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );

      return res.json({
        count: items.length,
        reportCount: reportItems.length,
        serverLogCount: serverItems.length,
        items,
      });
    }),
  );

  // Periodic retention pruning. Best-effort; unref so it never blocks exit.
  const timer = setInterval(() => {
    void cleanupDiagnostics();
  }, CLEANUP_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
};

const safeParse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

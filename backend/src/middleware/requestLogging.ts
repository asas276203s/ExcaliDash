/**
 * Request logging middleware — records structured ServerLog rows for the
 * ExcaliDash bug tracker.
 *
 * Policy (keeps volume low, signal high):
 *   - 4xx / 5xx responses: always logged.
 *   - 2xx / 3xx responses: logged ONLY when slow (> SLOW_REQUEST_MS).
 *
 * Correlation: the SPA attaches an `X-Session-Id` header to every API call;
 * we persist it so a client trace and its server-side request row can be
 * stitched together on a time axis via GET /diagnostics/recent?sessionId=...
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { getSessionIdFromHeaders, recordServerLog } from "../diagnostics/store";

const SLOW_REQUEST_MS = 1000;

// Never log the telemetry endpoints themselves (avoids feedback loops) or
// pure health noise.
const isIgnoredPath = (path: string): boolean =>
  path.startsWith("/diagnostics") ||
  path === "/health" ||
  path === "/csrf-token";

export const requestLoggingMiddleware = (): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isIgnoredPath(req.path)) return next();
    const startedAt = Date.now();

    res.on("finish", () => {
      const durationMs = Date.now() - startedAt;
      const status = res.statusCode;
      const isError = status >= 400;
      const isSlow = durationMs > SLOW_REQUEST_MS;
      if (!isError && !isSlow) return;

      const requestId =
        (req.headers["x-request-id"] as string | undefined) ?? null;
      void recordServerLog({
        level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
        type: "request",
        sessionId: getSessionIdFromHeaders(req.headers),
        drawingId: extractDrawingId(req.path),
        requestId,
        route: `${req.method} ${req.path}`,
        method: req.method,
        status,
        durationMs,
        message: isError
          ? `HTTP ${status}`
          : `slow ${durationMs}ms`,
        payload: {
          query: sanitizeQuery(req.query),
          contentLength: req.headers["content-length"] ?? null,
          userId: req.user?.id ?? null,
        },
      });
    });

    next();
  };
};

const extractDrawingId = (path: string): string | null => {
  const match = path.match(/\/drawings\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
};

const sanitizeQuery = (query: unknown): Record<string, unknown> => {
  if (!query || typeof query !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
    // Keep it small — never persist large or sensitive query blobs.
    if (typeof v === "string" && v.length <= 200) out[k] = v;
  }
  return out;
};

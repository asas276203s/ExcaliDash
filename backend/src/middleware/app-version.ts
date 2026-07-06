import type { RequestHandler } from "express";

/**
 * Resolve the current app build identifier.
 *
 * Zeabur exposes the commit SHA as `ZEABUR_GIT_COMMIT_SHA` in the runtime env.
 * Alternative deploys can pass `BUILD_HASH` explicitly. Falls back to `"dev"`
 * so local development still emits a header (rather than nothing) — the
 * frontend never treats `"dev"` as an update trigger anyway because it stays
 * constant between boot and subsequent responses.
 */
export const getAppVersion = (): string => {
  const sha = process.env.ZEABUR_GIT_COMMIT_SHA;
  if (typeof sha === "string" && sha.trim().length > 0) return sha.trim();
  const explicit = process.env.BUILD_HASH;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim();
  }
  return "dev";
};

/**
 * Advertise the running build's identifier on every response so the SPA can
 * detect that the server has moved to a new deploy and prompt a reload.
 *
 * Header intentionally lives outside `X-Request-ID` / rate-limit handling —
 * it's a stable app-wide constant, cheap to set, and useful even on errors.
 */
export const appVersionMiddleware = (): RequestHandler => {
  const version = getAppVersion();
  return (_req, res, next) => {
    res.setHeader("X-App-Version", version);
    next();
  };
};

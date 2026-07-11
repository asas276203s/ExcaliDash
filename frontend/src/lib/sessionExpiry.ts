/**
 * Session-expiry bridge.
 *
 * The axios interceptors (api/auth.ts) live outside React and cannot use
 * react-router's `navigate`. When they detect that the session is genuinely
 * gone (a 401 that survived a refresh attempt), they call
 * `notifySessionExpired()`; the AuthProvider subscribes with a handler that
 * clears the in-memory user + caches and performs a clean SPA redirect to
 * `/login?returnTo=...`.
 *
 * Before this bridge existed, `clearStoredAuth()` only wiped localStorage — the
 * React `user` state stayed truthy, so `ProtectedRoute` kept rendering
 * authenticated views (Dashboard) that immediately 401'd, and the editor could
 * strand the user on a dead-end "Invalid or expired token" screen. Routing the
 * recovery through React fixes both and preserves where the user was.
 */
type SessionExpiredHandler = (returnTo: string) => void;

const handlers = new Set<SessionExpiredHandler>();

const AUTH_PATH_PREFIXES = [
  "/login",
  "/register",
  "/reset-password",
  "/reset-password-confirm",
  "/auth-setup",
];

/**
 * Resolve a safe same-origin path to return to after re-authentication. Never
 * bounces the user back onto an auth screen (which would look like a no-op
 * login), and never trusts an absolute/off-site URL.
 */
export const computeReturnTo = (explicit?: string): string => {
  const fromLocation =
    typeof window !== "undefined"
      ? `${window.location.pathname}${window.location.search}${window.location.hash}`
      : "/";
  const candidate =
    typeof explicit === "string" && explicit.startsWith("/")
      ? explicit
      : fromLocation;
  if (!candidate.startsWith("/")) return "/";
  if (AUTH_PATH_PREFIXES.some((prefix) => candidate.startsWith(prefix))) {
    return "/";
  }
  return candidate;
};

export const onSessionExpired = (
  handler: SessionExpiredHandler,
): (() => void) => {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
};

/**
 * Notify subscribers that the session has expired.
 *
 * @returns `true` if at least one React subscriber handled the redirect, so the
 * caller can skip its hard-navigation fallback. `false` means no AuthProvider
 * is mounted yet (very early boot) and the caller should fall back to
 * `window.location`.
 */
export const notifySessionExpired = (explicitReturnTo?: string): boolean => {
  if (handlers.size === 0) return false;
  const returnTo = computeReturnTo(explicitReturnTo);
  handlers.forEach((handler) => {
    try {
      handler(returnTo);
    } catch {
      /* a faulty subscriber must never wedge auth recovery */
    }
  });
  return true;
};

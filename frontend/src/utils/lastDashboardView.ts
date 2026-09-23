/**
 * The dashboard reads its selected collection straight off the URL, so every
 * "home" navigation that hardcodes `/` drops the user back on All Drawings.
 * Remember the last dashboard location instead and return there.
 *
 * Storage is best-effort: a private window (or blocked site data) throws on
 * access, and losing the value only costs us the default `/`.
 */
const KEY = "excalidash:last-dashboard-view";

const DASHBOARD_PATHS = ["/", "/collections"];

export const isDashboardPath = (pathname: string): boolean =>
  DASHBOARD_PATHS.includes(pathname);

export const rememberDashboardView = (pathname: string, search: string): void => {
  if (!isDashboardPath(pathname)) return;
  try {
    window.localStorage.setItem(KEY, `${pathname}${search || ""}`);
  } catch {
    // Storage unavailable — the next read just falls back to the default.
  }
};

export const getRememberedDashboardView = (): string => {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (!stored || !stored.startsWith("/")) return "/";
    // Only ever hand back a known dashboard route: a stale or tampered value
    // must not become an open redirect or a jump to an unrelated page.
    const [pathname] = stored.split("?");
    return isDashboardPath(pathname) ? stored : "/";
  } catch {
    return "/";
  }
};

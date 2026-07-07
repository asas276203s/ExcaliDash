import axios from "axios";
import { appVersionStore } from "../utils/appVersion";
import { diagnostics } from "../lib/diagnostics";

export const API_URL = import.meta.env.VITE_API_URL || "/api";

export const api = axios.create({
  baseURL: API_URL,
  withCredentials: true,
});

// Response interceptor: record backend build id (X-App-Version) so the SPA
// can prompt for reload when the running frontend bundle falls behind the
// server. See `utils/appVersion.ts` for the state machine.
const readAppVersionHeader = (response: {
  headers?: Record<string, unknown> | { get?: (name: string) => string | null };
}): string | null => {
  const headers = response.headers as any;
  if (!headers) return null;
  if (typeof headers.get === "function") {
    const v = headers.get("x-app-version");
    return typeof v === "string" ? v : null;
  }
  const direct = headers["x-app-version"] ?? headers["X-App-Version"];
  return typeof direct === "string" ? direct : null;
};

api.interceptors.response.use(
  (response) => {
    const version = readAppVersionHeader(response);
    appVersionStore.recordVersion(version);
    // Stamp the real backend build SHA onto client diagnostic entries so a
    // trace can be tied to the exact deploy the user was running.
    diagnostics.setAppVersion(version);
    return response;
  },
  (error) => {
    if (error?.response) {
      const version = readAppVersionHeader(error.response);
      appVersionStore.recordVersion(version);
      diagnostics.setAppVersion(version);
    }
    return Promise.reject(error);
  },
);

// Correlation: attach the diagnostics session id to every API request so the
// backend request/save logs can be stitched to the client trace on a time
// axis (GET /api/diagnostics/recent?sessionId=...).
api.interceptors.request.use((config) => {
  try {
    config.headers = config.headers ?? {};
    (config.headers as Record<string, string>)["X-Session-Id"] =
      diagnostics.getSessionId();
  } catch {
    /* never block a request over telemetry */
  }
  return config;
});

export { default as axios } from "axios";
export const isAxiosError = axios.isAxiosError;
export default api;

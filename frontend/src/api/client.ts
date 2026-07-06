import axios from "axios";
import { appVersionStore } from "../utils/appVersion";

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
    appVersionStore.recordVersion(readAppVersionHeader(response));
    return response;
  },
  (error) => {
    if (error?.response) {
      appVersionStore.recordVersion(readAppVersionHeader(error.response));
    }
    return Promise.reject(error);
  },
);

export { default as axios } from "axios";
export const isAxiosError = axios.isAxiosError;
export default api;

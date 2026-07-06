import { useSyncExternalStore } from "react";
import { appVersionStore, type AppVersionState } from "../utils/appVersion";

/**
 * React hook binding the module-level app-version store into components.
 *
 * Uses `useSyncExternalStore` so subscribers are guaranteed a consistent
 * snapshot even when the interceptor fires between renders.
 */
export const useAppVersion = (): AppVersionState =>
  useSyncExternalStore(appVersionStore.subscribe, appVersionStore.getState);

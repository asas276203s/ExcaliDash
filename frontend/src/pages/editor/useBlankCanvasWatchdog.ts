import { useEffect } from "react";
import type { MutableRefObject } from "react";
import { diagnostics, isBlankCanvasState } from "../../lib/diagnostics";

const WATCHDOG_INTERVAL_MS = 10_000;

type WatchdogInput = {
  excalidrawAPI: MutableRefObject<any>;
  latestElementsRef: MutableRefObject<readonly any[]>;
  drawingId?: string;
  isReady: boolean;
};

/**
 * Blank-canvas watchdog. Every 10s it compares what Excalidraw is actually
 * rendering against what our element tracker believes should be on screen. A
 * scene of zero rendered elements while the tracker still holds renderable
 * content is the "白屏" signature — we log it and auto-flush so the trace
 * reaches the backend bug tracker without the user having to do anything.
 *
 * `getSceneElements()` returns non-deleted elements, so we compare against the
 * non-deleted tracked count to avoid false positives right after a legitimate
 * delete-all.
 */
export const useBlankCanvasWatchdog = ({
  excalidrawAPI,
  latestElementsRef,
  drawingId,
  isReady,
}: WatchdogInput): void => {
  useEffect(() => {
    if (!isReady) return;
    let alreadyReported = false;

    const interval = setInterval(() => {
      const api = excalidrawAPI.current;
      if (!api || typeof api.getSceneElements !== "function") return;
      let sceneCount = 0;
      try {
        sceneCount = api.getSceneElements().length;
      } catch {
        return;
      }
      const trackedRenderable = (latestElementsRef.current ?? []).filter(
        (el: any) => el && !el.isDeleted,
      ).length;

      if (isBlankCanvasState(sceneCount, trackedRenderable)) {
        if (alreadyReported) return;
        alreadyReported = true;
        diagnostics.log(
          "blank-canvas-detected",
          { sceneCount, trackedRenderable, drawingId: drawingId ?? null },
          "error",
        );
        void diagnostics.flush("blank-canvas-watchdog");
      } else {
        // Recovered — allow a future divergence to report again.
        alreadyReported = false;
      }
    }, WATCHDOG_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [excalidrawAPI, latestElementsRef, drawingId, isReady]);
};

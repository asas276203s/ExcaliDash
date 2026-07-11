import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  restoreElements,
  newElementWith,
  CaptureUpdateAction,
} from "@excalidraw/excalidraw";
import clsx from "clsx";
import {
  clampFontSize,
  collectTargetTextElements,
  computeDisplayFontSize,
  nextFontSize,
  DEFAULT_FONT_SIZE,
} from "./fontSizeUtils";

type FontSizeControlProps = {
  excalidrawAPIRef: React.MutableRefObject<any>;
  /** UIAppState handed in by Excalidraw's `renderTopRightUI` slot. */
  appState: any;
  canEdit: boolean;
};

/**
 * FontSizeControl — our own lightweight floating control that shows the
 * current text font size in px and lets the user type an exact value.
 *
 * Why we own this instead of patching Excalidraw's property panel: the panel
 * is rendered inside the (canary) library bundle and only offers S/M/L/XL
 * presets with no numeric readout. Rather than fork the library UI (a
 * maintenance liability across canary bumps), we mount into the supported
 * `renderTopRightUI` slot. That slot re-runs on every appState change, so the
 * control reactively follows selection changes AND preset (S/M/L/XL) clicks
 * with no manual subscription.
 *
 * Apply mechanism: for each targeted text element we build a new element with
 * the updated `fontSize`, then run the library's own `restoreElements(...,
 * { refreshDimensions: true })` to recompute the text bounding box (this also
 * handles container-bound labels — refreshDimensions reads the container from
 * the elements map). Finally `updateScene(... CaptureUpdateAction.IMMEDIATELY)`
 * commits it, which feeds the existing autosave + collaboration pipeline and
 * makes the change undoable.
 */
export const FontSizeControl: React.FC<FontSizeControlProps> = ({
  excalidrawAPIRef,
  appState,
  canEdit,
}) => {
  const api = excalidrawAPIRef.current;
  const selectedElementIds = appState?.selectedElementIds ?? {};
  const elements = api?.getSceneElements?.() ?? [];
  const targets = collectTargetTextElements(elements, selectedElementIds);
  const display = computeDisplayFontSize(targets); // number | "mixed" | null

  const [draft, setDraft] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);
  const isFocusedRef = useRef(false);

  const displayText = display === "mixed" || display == null ? "" : String(display);

  // Keep the input mirrored to the live value, but never clobber what the user
  // is actively typing.
  useEffect(() => {
    if (isFocusedRef.current) return;
    setDraft(displayText);
  }, [displayText]);

  const applyFontSize = useCallback(
    (value: number): number | null => {
      const currentApi = excalidrawAPIRef.current;
      if (!currentApi) return null;

      const size = clampFontSize(value);
      const allElements = currentApi.getSceneElements();
      const currentSelection =
        currentApi.getAppState?.().selectedElementIds ?? selectedElementIds;
      const targetIds = new Set(
        collectTargetTextElements(allElements, currentSelection).map(
          (el: any) => el.id,
        ),
      );
      if (targetIds.size === 0) return null;

      // Apply the new font size to the targeted text elements, then run the
      // whole scene back through `restoreElements`:
      //   - `refreshDimensions` recomputes each text element's bounding box for
      //     its (possibly new) font size — this is what makes the box grow/shrink.
      //   - `repairBindings` is REQUIRED: restoreElements short-circuits and
      //     skips the entire dimension-refresh pass unless this flag is set.
      // We pass the *full* scene (not just the changed elements) so the
      // bindings-repair map is complete; a partial set could strip a
      // container's other bound elements or detach a label. Recomputing the
      // untouched text elements is idempotent (same font metrics), matching how
      // Excalidraw restores a scene on load.
      const nextInput = allElements.map((el: any) =>
        targetIds.has(el.id) ? newElementWith(el, { fontSize: size }) : el,
      );
      const restored = restoreElements(nextInput, allElements, {
        refreshDimensions: true,
        repairBindings: true,
      });

      currentApi.updateScene({
        elements: restored,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      return size;
    },
    [excalidrawAPIRef, selectedElementIds],
  );

  const commitDraft = useCallback(() => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || draft.trim() === "") return;
    const applied = applyFontSize(parsed);
    if (applied != null) setDraft(String(applied));
  }, [applyFontSize, draft]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // IME safety: the user types with a 注音 IME. While a composition is in
      // progress, Enter/Arrow keys belong to the IME, not to us.
      if (event.nativeEvent.isComposing) return;

      if (event.key === "Enter") {
        event.preventDefault();
        commitDraft();
        inputRef.current?.blur();
        return;
      }

      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const parsed = Number(draft);
        const base = Number.isFinite(parsed) && draft.trim() !== ""
          ? parsed
          : typeof display === "number"
            ? display
            : DEFAULT_FONT_SIZE;
        const step = (event.shiftKey ? 4 : 1) * (event.key === "ArrowUp" ? 1 : -1);
        const applied = applyFontSize(nextFontSize(base, step));
        if (applied != null) setDraft(String(applied));
      }
    },
    [applyFontSize, commitDraft, display, draft],
  );

  const handleChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    // Digits only — keeps the field numeric without a native spinner.
    const cleaned = event.target.value.replace(/[^0-9]/g, "").slice(0, 3);
    setDraft(cleaned);
  }, []);

  const handleFocus = useCallback((event: React.FocusEvent<HTMLInputElement>) => {
    isFocusedRef.current = true;
    event.target.select();
  }, []);

  const handleBlur = useCallback(() => {
    isFocusedRef.current = false;
    // Revert any uncommitted edit back to the live value.
    setDraft(displayText);
  }, [displayText]);

  if (!canEdit) return null;
  if (targets.length === 0) return null;

  const isMixed = display === "mixed";

  return (
    <div
      data-testid="font-size-control"
      className={clsx(
        "inline-flex items-center gap-2",
        "h-9 px-2.5 rounded-lg",
        "bg-white/98 dark:bg-neutral-900/98",
        "border border-gray-200 dark:border-neutral-800",
        "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_12px_rgba(15,23,42,0.06)]",
        "dark:shadow-[0_1px_2px_rgba(0,0,0,0.5),0_4px_12px_rgba(0,0,0,0.4)]",
      )}
    >
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400 select-none">
        字級
      </span>
      <div className="inline-flex items-baseline gap-1">
        <input
          ref={inputRef}
          data-testid="font-size-input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          aria-label="字型大小 (px)"
          value={draft}
          placeholder={isMixed ? "混合" : ""}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className={clsx(
            "w-10 text-right bg-transparent outline-none",
            "text-sm font-semibold tabular-nums",
            "text-gray-900 dark:text-gray-100",
            "placeholder:text-gray-400 placeholder:font-normal dark:placeholder:text-gray-500",
          )}
        />
        <span className="text-xs font-medium text-gray-400 dark:text-gray-500 select-none">
          px
        </span>
      </div>
    </div>
  );
};

export default FontSizeControl;

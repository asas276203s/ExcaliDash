import React, { useEffect, useRef, useState } from "react";
import { Home, RotateCcw, X } from "lucide-react";
import clsx from "clsx";
import type { EditorTab } from "./useTabs";

/**
 * MIME-ish payload key for our internal HTML5 drag. Namespaced so external
 * drags (files, URLs, other apps) never masquerade as a tab reorder.
 */
const TAB_DRAG_MIME = "application/x-excalidash-tab-id";

interface TabBarProps {
  tabs: EditorTab[];
  activeId: string | null;
  hasClosedHistory: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onOpenInNewTab?: (id: string) => void;
  onReopenLastClosed: () => void;
  onReorderTab?: (fromId: string, toIndex: number) => void;
  onNavigateHome: () => void;
}

const fallbackName = (id: string): string =>
  id.length > 10 ? `${id.slice(0, 8)}…` : id;

interface TabItemProps {
  tab: EditorTab;
  isActive: boolean;
  showClose: boolean;
  isDragging: boolean;
  draggable: boolean;
  onActivate: () => void;
  onClose: () => void;
  onAuxOpen?: () => void;
  onDragStart: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: (event: React.DragEvent<HTMLDivElement>) => void;
}

const TabItem: React.FC<TabItemProps> = ({
  tab,
  isActive,
  showClose,
  isDragging,
  draggable,
  onActivate,
  onClose,
  onAuxOpen,
  onDragStart,
  onDragEnd,
}) => {
  const label = tab.name?.trim() || fallbackName(tab.id);
  const handlePointer = (event: React.MouseEvent<HTMLDivElement>) => {
    // Middle-click semantics: browser tabs close on middle-click. We reuse
    // that convention.
    if (event.button === 1) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey) {
      if (onAuxOpen) {
        event.preventDefault();
        onAuxOpen();
      }
      return;
    }
    onActivate();
  };

  return (
    <div
      role="tab"
      aria-selected={isActive}
      aria-grabbed={isDragging}
      tabIndex={0}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onMouseDown={handlePointer}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      className={clsx(
        "group relative flex items-center gap-2 h-full pl-3 pr-2 max-w-[220px] min-w-[120px]",
        "border-r border-gray-200 dark:border-neutral-800 cursor-pointer select-none",
        "text-sm transition-colors duration-100",
        isActive
          ? "bg-white dark:bg-neutral-950 text-gray-900 dark:text-white"
          : "bg-gray-100 dark:bg-neutral-900 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-neutral-800/60 hover:text-gray-800 dark:hover:text-gray-200",
        isDragging && "opacity-40",
      )}
      title={tab.name || tab.id}
    >
      {isActive && (
        <span
          aria-hidden
          className="absolute top-0 left-0 right-0 h-[2px] bg-indigo-500 dark:bg-indigo-400"
        />
      )}
      <span className="flex-1 truncate whitespace-nowrap">{label}</span>
      {showClose && (
        <button
          type="button"
          aria-label={`Close ${label}`}
          onMouseDown={(e) => {
            // Prevent the parent onMouseDown from firing (would activate).
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={clsx(
            "flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-gray-400",
            "hover:bg-gray-200 dark:hover:bg-neutral-700 hover:text-gray-700 dark:hover:text-gray-200",
            isActive
              ? "opacity-80"
              : "opacity-0 group-hover:opacity-80 focus:opacity-80",
          )}
        >
          <X size={14} strokeWidth={2.5} />
        </button>
      )}
    </div>
  );
};

export const TabBar: React.FC<TabBarProps> = ({
  tabs,
  activeId,
  hasClosedHistory,
  onActivate,
  onClose,
  onOpenInNewTab,
  onReopenLastClosed,
  onReorderTab,
  onNavigateHome,
}) => {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollShadow, setScrollShadow] = useState<"none" | "start" | "end" | "both">(
    "none",
  );

  // Drag-to-reorder state. `dragId` is the tab being dragged; `dropIndex` is
  // the visual insertion index (0..tabs.length) where the accent bar renders.
  // `dropIndicatorLeft` is the pixel offset relative to the scroller's content
  // box, used to position the indicator across horizontal scroll.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dropIndicatorLeft, setDropIndicatorLeft] = useState<number | null>(null);

  const resetDragState = () => {
    setDragId(null);
    setDropIndex(null);
    setDropIndicatorLeft(null);
  };

  const computeDropTarget = (
    scroller: HTMLDivElement,
    clientX: number,
  ): { index: number; left: number } => {
    const items = Array.from(
      scroller.querySelectorAll<HTMLElement>("[data-tab-id]"),
    );
    const scrollerRect = scroller.getBoundingClientRect();
    if (items.length === 0) {
      return { index: 0, left: scroller.scrollLeft };
    }
    for (let i = 0; i < items.length; i++) {
      const rect = items[i].getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      if (clientX < mid) {
        return { index: i, left: rect.left - scrollerRect.left + scroller.scrollLeft };
      }
    }
    const last = items[items.length - 1].getBoundingClientRect();
    return {
      index: items.length,
      left: last.right - scrollerRect.left + scroller.scrollLeft,
    };
  };

  const handleScrollerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!dragId) return;
    // dataTransfer.types is lower-cased by the browser; our custom MIME is
    // already lower-case so this compares directly.
    if (!event.dataTransfer.types.includes(TAB_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const { index, left } = computeDropTarget(scroller, event.clientX);
    setDropIndex(index);
    setDropIndicatorLeft(left);
  };

  const handleScrollerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    // If the pointer left the scroller entirely (relatedTarget is outside or
    // null), hide the indicator. We keep dragId so re-entry restores it.
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    setDropIndex(null);
    setDropIndicatorLeft(null);
  };

  const handleScrollerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!dragId) return;
    const fromId = event.dataTransfer.getData(TAB_DRAG_MIME) || dragId;
    event.preventDefault();
    const fromIndex = tabs.findIndex((t) => t.id === fromId);
    if (fromIndex === -1) {
      resetDragState();
      return;
    }
    // Visual insertion index → destination index in the resulting array.
    // When moving forward (visualIndex > fromIndex), one slot behind the
    // dragged tab disappears, so subtract 1 to keep the insertion point stable.
    const visualIndex =
      dropIndex ?? computeDropTarget(event.currentTarget, event.clientX).index;
    const targetIndex = visualIndex > fromIndex ? visualIndex - 1 : visualIndex;
    if (targetIndex !== fromIndex && onReorderTab) {
      onReorderTab(fromId, targetIndex);
    }
    resetDragState();
  };

  // Ensure the active tab stays visible when it changes.
  useEffect(() => {
    if (!activeId) return;
    const el = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-tab-id="${CSS.escape(activeId)}"]`,
    );
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [activeId]);

  const updateShadows = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const atStart = el.scrollLeft <= 1;
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
    if (atStart && atEnd) setScrollShadow("none");
    else if (atStart) setScrollShadow("end");
    else if (atEnd) setScrollShadow("start");
    else setScrollShadow("both");
  };

  useEffect(() => {
    updateShadows();
    const el = scrollerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateShadows);
    observer.observe(el);
    return () => observer.disconnect();
  }, [tabs.length]);

  return (
    <div
      role="tablist"
      aria-label="Open drawings"
      className={clsx(
        "flex items-stretch h-9 border-b border-gray-200 dark:border-neutral-800",
        "bg-gray-100 dark:bg-neutral-900 select-none",
      )}
    >
      <button
        type="button"
        onClick={onNavigateHome}
        aria-label="Open dashboard"
        title="Open dashboard"
        className={clsx(
          "flex items-center justify-center px-3 h-full",
          "text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200",
          "border-r border-gray-200 dark:border-neutral-800",
          "hover:bg-gray-50 dark:hover:bg-neutral-800/60 transition-colors",
        )}
      >
        <Home size={15} />
      </button>
      <div
        ref={scrollerRef}
        onScroll={updateShadows}
        onDragOver={handleScrollerDragOver}
        onDragLeave={handleScrollerDragLeave}
        onDrop={handleScrollerDrop}
        className={clsx(
          "relative flex items-stretch flex-1 min-w-0 overflow-x-auto overscroll-x-contain scrollbar-none",
          scrollShadow === "start" &&
            "shadow-[inset_10px_0_8px_-8px_rgba(0,0,0,0.15)]",
          scrollShadow === "end" &&
            "shadow-[inset_-10px_0_8px_-8px_rgba(0,0,0,0.15)]",
          scrollShadow === "both" &&
            "shadow-[inset_10px_0_8px_-8px_rgba(0,0,0,0.15),inset_-10px_0_8px_-8px_rgba(0,0,0,0.15)]",
        )}
        style={{ scrollbarWidth: "none" }}
      >
        {tabs.map((tab) => (
          <div key={tab.id} data-tab-id={tab.id} className="flex">
            <TabItem
              tab={tab}
              isActive={tab.id === activeId}
              showClose={tabs.length > 0}
              isDragging={dragId === tab.id}
              draggable={!!onReorderTab}
              onActivate={() => onActivate(tab.id)}
              onClose={() => onClose(tab.id)}
              onAuxOpen={onOpenInNewTab ? () => onOpenInNewTab(tab.id) : undefined}
              onDragStart={(e) => {
                if (!onReorderTab) return;
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData(TAB_DRAG_MIME, tab.id);
                // Some browsers also require a text payload to fire drop.
                e.dataTransfer.setData("text/plain", tab.id);
                setDragId(tab.id);
              }}
              onDragEnd={() => {
                // Fires whether the drop succeeded or was cancelled (esc, off-bar).
                resetDragState();
              }}
            />
          </div>
        ))}
        {dropIndex !== null && dropIndicatorLeft !== null && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-0 w-[2px] bg-indigo-500 dark:bg-indigo-400"
            style={{ left: dropIndicatorLeft - 1 }}
          />
        )}
      </div>
      <button
        type="button"
        onClick={onReopenLastClosed}
        disabled={!hasClosedHistory}
        aria-label="Reopen last closed tab"
        title="Reopen last closed tab (Cmd/Ctrl+Shift+T)"
        className={clsx(
          "flex items-center justify-center px-3 h-full border-l border-gray-200 dark:border-neutral-800",
          "text-gray-500 dark:text-gray-400 transition-colors",
          hasClosedHistory
            ? "hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-neutral-800/60"
            : "opacity-40 cursor-not-allowed",
        )}
      >
        <RotateCcw size={14} />
      </button>
    </div>
  );
};

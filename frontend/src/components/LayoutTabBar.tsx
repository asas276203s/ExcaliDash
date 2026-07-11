import React from "react";
import { useNavigate } from "react-router-dom";
import { TabBar } from "../pages/editor/TabBar";
import { useTabsContext } from "../context/TabsContext";

// Persistent tab bar rendered above the main content area of Layout so the
// user's open drawings stay visible on Dashboard / Settings / Admin /
// Profile — not only in the Editor. Reads tab state from TabsContext
// (single source of truth shared with EditorView's tab bar), and drives
// react-router navigation on activate.

export const LayoutTabBar: React.FC = () => {
  const navigate = useNavigate();
  const {
    tabs,
    activeId,
    activateTab,
    closeTab,
    reopenLastClosed,
    moveTab,
    hasClosedHistory,
    visible,
  } = useTabsContext();

  if (!visible) return null;

  return (
    // z-index must beat DrawingCard's own stacking (card body: z-10, hover
    // actions: z-20) — otherwise cards scrolling underneath tie/win on DOM
    // order and paint over the sticky bar. Stay below the mobile sidebar
    // backdrop (z-30) so an open drawer still dims/covers this bar.
    <div className="sticky top-0 z-[25] mb-3 sm:mb-4">
      <TabBar
        tabs={tabs}
        activeId={activeId}
        hasClosedHistory={hasClosedHistory}
        onActivate={activateTab}
        onClose={closeTab}
        onOpenInNewTab={(id) => activateTab(id)}
        onReopenLastClosed={reopenLastClosed}
        onNavigateHome={() => navigate("/")}
        onReorderTab={moveTab}
      />
    </div>
  );
};

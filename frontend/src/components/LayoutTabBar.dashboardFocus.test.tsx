import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { TabsProvider, useTabsContext } from "../context/TabsContext";
import { LayoutTabBar } from "./LayoutTabBar";
import { OPEN_TABS_KEY } from "../utils/tabsStorage";

/**
 * Regression coverage for "clicking a drawing from the Dashboard doesn't
 * auto-focus its tab" (2026-07-11).
 *
 * Root cause: Dashboard wrote the new tab straight to localStorage and then
 * called a raw `navigate()`. That changes the route (and therefore
 * `activeId`, which is derived directly from the route) one render BEFORE
 * the in-memory `tabs` array — and therefore the tab's DOM node — exists.
 * TabBar's "scroll the active tab into view" effect was keyed only on
 * `activeId`, so it ran once (found nothing, since the tab wasn't in the DOM
 * yet) and never got a second chance once the tab actually appeared, because
 * `activeId` itself didn't change again.
 *
 * Fixed two ways:
 *  1. Root cause: Dashboard-originated opens now go through `openTab`, which
 *     adds/activates the tab and navigates in the SAME setTabs updater, so
 *     the tab's DOM node and the route's activeId land in one commit.
 *  2. Defensive backstop: TabBar's scroll effect now also depends on `tabs`,
 *     so even a caller that reintroduces the old raw-navigate pattern still
 *     gets the active tab scrolled into view once state catches up.
 */

const seedWorkspace = (ids: string[]) =>
  window.localStorage.setItem(
    OPEN_TABS_KEY,
    JSON.stringify(ids.map((id) => ({ id, name: id }))),
  );

// Mirrors the CURRENT (fixed) Dashboard.tsx onOpenDrawing handler: add +
// activate the tab via the context's openTab.
const FixedDashboardStub: React.FC<{ targetId: string; name: string }> = ({
  targetId,
  name,
}) => {
  const { openTab } = useTabsContext();
  return (
    <button onClick={() => openTab(targetId, { name, preserveSearch: false })}>
      open-from-dashboard-fixed
    </button>
  );
};

// Mirrors the OLD (buggy) Dashboard.tsx onOpenDrawing handler: a direct
// localStorage write + a raw navigate(), bypassing useTabs' in-memory state
// entirely. Kept here to prove the TabBar defensive backstop (fix #2) still
// saves this anti-pattern if it ever creeps back in.
const BuggyDashboardStub: React.FC<{ targetId: string }> = ({ targetId }) => {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => {
        const current = JSON.parse(
          window.localStorage.getItem(OPEN_TABS_KEY) || "[]",
        ) as { id: string }[];
        seedWorkspace([...current.map((t) => t.id), targetId]);
        navigate(`/editor/${targetId}`);
      }}
    >
      open-from-dashboard-buggy
    </button>
  );
};

const renderHarness = (
  DashboardStub: React.FC<{ targetId: string; name?: string }>,
  stubProps: { targetId: string; name?: string },
) =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <TabsProvider>
        <LayoutTabBar />
        <Routes>
          <Route path="/" element={<DashboardStub {...stubProps} />} />
          <Route path="/editor/:id" element={<div>editor</div>} />
        </Routes>
      </TabsProvider>
    </MemoryRouter>,
  );

describe("LayoutTabBar — Dashboard click focuses the opened tab", () => {
  const scrollCalls: HTMLElement[] = [];

  beforeEach(() => {
    window.localStorage.clear();
    scrollCalls.length = 0;
    // jsdom doesn't implement scrollIntoView; stub it and record the target
    // element so we can assert exactly which tab was scrolled into view.
    Element.prototype.scrollIntoView = vi.fn(function (this: HTMLElement) {
      scrollCalls.push(this);
    });
    // jsdom also doesn't implement ResizeObserver, which TabBar uses to
    // recompute scroll shadows — unrelated to this test, just needs a stub.
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
      class ResizeObserverStub {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  });

  it("openTab (fixed path): new tab is active AND scrolled into view immediately", () => {
    seedWorkspace(["a", "b", "c"]);

    renderHarness(FixedDashboardStub, {
      targetId: "new-drawing",
      name: "New Drawing",
    });

    fireEvent.click(screen.getByText("open-from-dashboard-fixed"));

    const tab = document.querySelector('[data-tab-id="new-drawing"] [role="tab"]');
    expect(tab).not.toBeNull();
    expect(tab).toHaveAttribute("aria-selected", "true");

    // scrollIntoView must have been invoked targeting THIS tab's element,
    // not just called on some other (already-open) tab.
    expect(
      scrollCalls.some((el) => el.getAttribute("data-tab-id") === "new-drawing"),
    ).toBe(true);
  });

  it("raw navigate + localStorage write (old buggy path): backstop still scrolls the new tab into view", () => {
    seedWorkspace(["a", "b", "c"]);

    renderHarness(BuggyDashboardStub, { targetId: "new-drawing" });

    fireEvent.click(screen.getByText("open-from-dashboard-buggy"));

    // The "keep current drawing id represented as an open tab" effect in
    // useTabs.ts adds the tab a render after activeId already switched. The
    // tab still ends up active...
    const tab = document.querySelector('[data-tab-id="new-drawing"] [role="tab"]');
    expect(tab).not.toBeNull();
    expect(tab).toHaveAttribute("aria-selected", "true");

    // ...and thanks to the `tabs` dependency backstop in TabBar, it is also
    // scrolled into view once it exists — this assertion is what would have
    // failed before the TabBar fix (the effect would have fired once, too
    // early, against a DOM that didn't have this tab yet, and never again).
    expect(
      scrollCalls.some((el) => el.getAttribute("data-tab-id") === "new-drawing"),
    ).toBe(true);
  });
});

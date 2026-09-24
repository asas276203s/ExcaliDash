import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Sidebar } from "./Sidebar";

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ logout: () => {}, user: { id: "u1", name: "U" }, authEnabled: true }),
}));

// Returning to the dashboard should reveal the collection that is actually
// selected, instead of leaving the sidebar wherever it was last scrolled.

const collections = Array.from({ length: 30 }, (_, i) => ({
  id: `c${i}`,
  name: `Collection ${i}`,
})) as any[];

const baseProps = {
  collections,
  onSelectCollection: () => {},
  onCreateCollection: () => {},
  onRenameCollection: () => {},
  onDeleteCollection: () => {},
  onMoveDrawing: () => {},
  isOpen: true,
  onClose: () => {},
};

const renderSidebar = (selectedCollectionId: string | null | undefined) =>
  render(
    <MemoryRouter>
      <Sidebar {...(baseProps as any)} selectedCollectionId={selectedCollectionId} />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("Sidebar reveals the active collection", () => {
  it("scrolls an off-screen selected collection into view", () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    // jsdom reports zero-size rects; make the nav measurable and the target
    // sit below the fold so the visibility check has something real to judge.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const isItem = (this as HTMLElement).dataset?.sidebarItemId === "c25";
        return {
          top: isItem ? 900 : 0,
          bottom: isItem ? 940 : 600,
          height: isItem ? 40 : 600,
          left: 0,
          right: 240,
          width: 240,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );

    renderSidebar("c25");

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy.mock.calls[0][0]).toMatchObject({ block: "center" });
  });

  it("leaves the scroll position alone when the selection is already visible", () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          top: 10,
          bottom: 50,
          height: 40,
          left: 0,
          right: 240,
          width: 240,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );

    renderSidebar("c3");

    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("does nothing for the built-in views", () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    renderSidebar(undefined);
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});

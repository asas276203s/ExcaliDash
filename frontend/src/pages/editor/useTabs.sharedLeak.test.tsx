import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { useTabs } from "./useTabs";
import { OPEN_TABS_KEY } from "../../utils/tabsStorage";

// Regression coverage for the "share link leaks other tabs" privacy bug.
// A `/shared/:id` view must never surface the sharer's OTHER open drawings,
// whether they arrive via the URL `?tabs=` param or via localStorage.

let observedSearch = "";
const LocationSpy: React.FC = () => {
  const loc = useLocation();
  observedSearch = loc.search;
  return null;
};

const wrapperFor =
  (entry: string): React.FC<{ children: React.ReactNode }> =>
  ({ children }) => (
    <MemoryRouter initialEntries={[entry]}>
      <LocationSpy />
      {children}
    </MemoryRouter>
  );

beforeEach(() => {
  observedSearch = "";
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("useTabs — shared route does not leak other drawings", () => {
  it("ignores ?tabs= on /shared/:id and scrubs it from the URL", () => {
    const { result } = renderHook(() => useTabs(undefined), {
      wrapper: wrapperFor(
        "/shared/target?tabs=target,secret-drawing-1,secret-drawing-2&active=target",
      ),
    });

    // No other-drawing tabs are exposed to the shared view.
    expect(result.current.tabs).toEqual([]);

    // The URL is scrubbed: the sharer's other drawing ids are gone.
    expect(observedSearch).not.toContain("secret-drawing-1");
    expect(observedSearch).not.toContain("secret-drawing-2");
    expect(observedSearch).not.toContain("tabs=");
    expect(observedSearch).not.toContain("active=");
  });

  it("does not surface localStorage tabs on /shared/:id", () => {
    window.localStorage.setItem(
      OPEN_TABS_KEY,
      JSON.stringify([
        { id: "secret-a", name: "Salary" },
        { id: "secret-b", name: "Roadmap" },
      ]),
    );

    const { result } = renderHook(() => useTabs(undefined), {
      wrapper: wrapperFor("/shared/target"),
    });

    expect(result.current.tabs).toEqual([]);
  });

  it("preserves unrelated params while scrubbing tabs on /shared/:id", () => {
    renderHook(() => useTabs(undefined), {
      wrapper: wrapperFor("/shared/target?tabs=target,secret&addLibrary=lib1"),
    });

    expect(observedSearch).toContain("addLibrary=lib1");
    expect(observedSearch).not.toContain("secret");
    expect(observedSearch).not.toContain("tabs=");
  });

  it("still hydrates the tab workspace normally on /editor/:id", () => {
    const { result } = renderHook(() => useTabs("target"), {
      wrapper: wrapperFor("/editor/target?tabs=target,other-1&active=target"),
    });

    const ids = result.current.tabs.map((t) => t.id);
    expect(ids).toContain("target");
    expect(ids).toContain("other-1");
  });
});

import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, act } from "@testing-library/react";
import {
  MemoryRouter,
  useMatch,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useTabs } from "./useTabs";
import { OPEN_TABS_KEY, readOpenTabs } from "../../utils/tabsStorage";

// Regression coverage for "reopening a drawing wipes the multi-tab workspace".
// Mirrors TabsProvider: a single useTabs instance lives ABOVE the routes so it
// hydrates once and survives client-side navigation between /shared and /editor.

let navRef: ((to: string) => void) | null = null;
let latestTabs: string[] = [];
let observedSearch = "";

const Harness: React.FC = () => {
  const match = useMatch("/editor/:id");
  const currentDrawingId = match?.params?.id;
  const api = useTabs(currentDrawingId);
  const navigate = useNavigate();
  const loc = useLocation();
  navRef = (to: string) => navigate(to);
  latestTabs = api.tabs.map((t) => t.id);
  observedSearch = loc.search;
  return null;
};

beforeEach(() => {
  window.localStorage.clear();
  // Workspaces are per signed-in user; seed one so the seeded localStorage
  // workspace is in scope. Seeding the legacy (un-namespaced) key also exercises
  // the one-time migration into the user's scoped key on first read.
  window.localStorage.setItem(
    "excalidash-user",
    JSON.stringify({ id: "owner-1" }),
  );
  navRef = null;
  latestTabs = [];
  observedSearch = "";
});
afterEach(() => window.localStorage.clear());

const seedWorkspace = (ids: string[]) =>
  window.localStorage.setItem(
    OPEN_TABS_KEY,
    JSON.stringify(ids.map((id) => ({ id }))),
  );

describe("useTabs — workspace is not lost on reopen", () => {
  it("a single-tab ?tabs= URL does NOT shrink the localStorage workspace on fresh mount", () => {
    seedWorkspace(["a", "b", "c"]);
    render(
      <MemoryRouter initialEntries={["/editor/a?tabs=a&active=a"]}>
        <Harness />
      </MemoryRouter>,
    );
    // localStorage (source of truth) survives; URL is upgraded to the full set.
    expect(readOpenTabs().map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
    expect(latestTabs.sort()).toEqual(["a", "b", "c"]);
    expect(observedSearch).toContain("tabs=");
    expect(observedSearch).toContain("b");
    expect(observedSearch).toContain("c");
  });

  it("opening /editor/:id with no ?tabs= restores the workspace and keeps target open", () => {
    seedWorkspace(["a", "b", "c"]);
    render(
      <MemoryRouter initialEntries={["/editor/x"]}>
        <Harness />
      </MemoryRouter>,
    );
    // Existing workspace preserved + the freshly-opened target appended.
    expect(readOpenTabs().map((t) => t.id).sort()).toEqual([
      "a",
      "b",
      "c",
      "x",
    ]);
  });

  it("returning from /shared to /editor re-hydrates and does NOT wipe the workspace", () => {
    seedWorkspace(["a", "b", "c"]);
    render(
      <MemoryRouter initialEntries={["/shared/a"]}>
        <Harness />
      </MemoryRouter>,
    );
    // On /shared the workspace must be invisible in memory but intact on disk.
    expect(latestTabs).toEqual([]);
    expect(readOpenTabs().map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(observedSearch).not.toContain("tabs=");

    // Owner navigates from the shared view into the real editor (same session).
    act(() => navRef!("/editor/a"));

    expect(readOpenTabs().map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
    expect(latestTabs.sort()).toEqual(["a", "b", "c"]);
  });

  it("/shared visit never persists tab params (share-leak fix preserved)", () => {
    seedWorkspace(["secret-a", "secret-b"]);
    render(
      <MemoryRouter
        initialEntries={["/shared/t?tabs=t,secret-a,secret-b&active=t"]}
      >
        <Harness />
      </MemoryRouter>,
    );
    expect(latestTabs).toEqual([]);
    expect(observedSearch).not.toContain("tabs=");
    expect(observedSearch).not.toContain("secret-a");
    // localStorage untouched by the shared visit.
    expect(readOpenTabs().map((t) => t.id)).toEqual(["secret-a", "secret-b"]);
  });
});

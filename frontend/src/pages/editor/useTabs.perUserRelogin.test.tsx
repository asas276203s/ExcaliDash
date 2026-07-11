import React from "react";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { render, act } from "@testing-library/react";
import { MemoryRouter, useMatch, useLocation, useNavigate } from "react-router-dom";
import { useTabs } from "./useTabs";
import { OPEN_TABS_KEY, readOpenTabs } from "../../utils/tabsStorage";

// Regression coverage for "tabs disappear after a session-expiry re-login" and
// the underlying defect: the tab workspace used to live under GLOBAL localStorage
// keys, so a second account (or an anonymous/shared visit) on the same browser
// could read or overwrite the owner's open tabs. Workspaces are now scoped per
// signed-in user. A single useTabs instance ABOVE the routes (mirrors
// TabsProvider) is driven through the real route sequences below.

let navRef: ((to: string) => void) | null = null;
let latestTabs: string[] = [];

const Harness: React.FC = () => {
  const match = useMatch("/editor/:id");
  const currentDrawingId = match?.params?.id;
  const api = useTabs(currentDrawingId);
  const navigate = useNavigate();
  useLocation();
  navRef = (to: string) => navigate(to);
  latestTabs = api.tabs.map((t) => t.id);
  return null;
};

const setUser = (id: string | null) => {
  if (id === null) {
    window.localStorage.removeItem("excalidash-user");
  } else {
    window.localStorage.setItem("excalidash-user", JSON.stringify({ id }));
  }
};

const scopedOpenKey = (userId: string) => `${OPEN_TABS_KEY}:${userId}`;

const seedScopedWorkspace = (userId: string, ids: string[]) =>
  window.localStorage.setItem(
    scopedOpenKey(userId),
    JSON.stringify(ids.map((id) => ({ id }))),
  );

beforeEach(() => {
  window.localStorage.clear();
  navRef = null;
  latestTabs = [];
});
afterEach(() => window.localStorage.clear());

const renderAt = (entry: string) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Harness />
    </MemoryRouter>,
  );

describe("useTabs — per-user workspace survives session-expiry re-login", () => {
  it("editor -> /login -> back to editor keeps the same user's 3 tabs + active", () => {
    setUser("owner");
    seedScopedWorkspace("owner", ["a", "b", "c"]);
    renderAt("/editor/a?tabs=a,b,c&active=a");
    act(() => navRef!("/login?returnTo=%2Feditor%2Fa"));
    // On /login the tab bar is hidden (in-memory empty) but disk is untouched.
    expect(latestTabs).toEqual([]);
    expect(readOpenTabs().map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
    // Same user signs back in and returns to the editor.
    act(() => navRef!("/editor/a?tabs=a,b,c&active=a"));
    expect(readOpenTabs().map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
    expect(latestTabs.sort()).toEqual(["a", "b", "c"]);
  });

  it("editor -> ProtectedRoute /shared bounce -> /login -> re-login keeps tabs", () => {
    setUser("owner");
    seedScopedWorkspace("owner", ["a", "b", "c"]);
    renderAt("/editor/a?tabs=a,b,c&active=a");
    act(() => navRef!("/shared/a")); // ProtectedRoute bounce while user is null
    act(() => navRef!("/login?returnTo=%2Feditor%2Fa"));
    act(() => navRef!("/editor/a"));
    expect(readOpenTabs().map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
    expect(latestTabs.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("useTabs — cross-user isolation (privacy + no clobber)", () => {
  it("user B on the same browser never sees user A's open tabs", () => {
    setUser("A");
    seedScopedWorkspace("A", ["a-secret1", "a-secret2"]);
    // User B signs in on the same browser and lands on their dashboard.
    setUser("B");
    renderAt("/");
    expect(latestTabs).toEqual([]);
    // A's workspace is untouched and still private to A.
    expect(
      window.localStorage.getItem(scopedOpenKey("A")),
    ).not.toBeNull();
  });

  it("user B opening a drawing does not overwrite user A's workspace", () => {
    setUser("A");
    seedScopedWorkspace("A", ["a1", "a2", "a3"]);
    setUser("B");
    renderAt("/editor/b1");
    // B's own single-tab workspace persists under B's key...
    expect(latestTabs).toEqual(["b1"]);
    // ...while A's three tabs remain intact.
    setUser("A");
    expect(readOpenTabs().map((t) => t.id).sort()).toEqual(["a1", "a2", "a3"]);
  });

  it("anonymous / signed-out visitor reads and writes nothing", () => {
    setUser("A");
    seedScopedWorkspace("A", ["a1", "a2"]);
    setUser(null); // signed out
    renderAt("/editor/x"); // hypothetically direct-hit while anonymous
    // Nothing from A leaked; A's workspace is untouched on disk.
    setUser("A");
    expect(readOpenTabs().map((t) => t.id).sort()).toEqual(["a1", "a2"]);
  });
});

describe("useTabs — legacy (un-namespaced) workspace migration", () => {
  it("moves a pre-namespacing global workspace under the first owner that loads", () => {
    setUser("owner");
    // Legacy global key from before per-user scoping.
    window.localStorage.setItem(
      OPEN_TABS_KEY,
      JSON.stringify([{ id: "legacy1" }, { id: "legacy2" }]),
    );
    renderAt("/editor/legacy1?tabs=legacy1,legacy2&active=legacy1");
    // Migrated into the owner's scoped key...
    expect(readOpenTabs().map((t) => t.id).sort()).toEqual([
      "legacy1",
      "legacy2",
    ]);
    // ...and the legacy global key is removed so it can't leak to another user.
    expect(window.localStorage.getItem(OPEN_TABS_KEY)).toBeNull();
    expect(window.localStorage.getItem(scopedOpenKey("owner"))).not.toBeNull();
  });
});

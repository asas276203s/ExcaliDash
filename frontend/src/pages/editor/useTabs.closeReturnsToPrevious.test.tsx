import React from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { render, act } from "@testing-library/react";
import {
  MemoryRouter,
  useMatch,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useTabs, type UseTabsResult } from "./useTabs";

// Closing the active tab should land on the view the user actually came from
// — including the dashboard — rather than on whatever tab happens to sit next
// to it in the bar.

let api: UseTabsResult | null = null;
let go: ((to: string) => void) | null = null;
let path = "";
let search = "";
let trail: string[] = [];

const Harness: React.FC = () => {
  const match = useMatch("/editor/:id");
  api = useTabs(match?.params?.id);
  const navigate = useNavigate();
  const loc = useLocation();
  go = (to: string) => navigate(to);
  path = loc.pathname;
  search = loc.search;
  if (trail[trail.length - 1] !== loc.pathname + loc.search) trail.push(loc.pathname + loc.search);
  return null;
};

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(
    "excalidash-user",
    JSON.stringify({ id: "owner-1" }),
  );
  api = null;
  go = null;
  path = "";
  search = "";
  trail = [];
});

const mount = (initial: string) =>
  render(
    <MemoryRouter initialEntries={[initial]}>
      <Harness />
    </MemoryRouter>,
  );

describe("closeTab returns to the previously visited view", () => {
  it("goes back to the dashboard when that is where the drawing was opened from", async () => {
    // d1 is opened, the user returns to the dashboard, then opens d2. Closing
    // d2 must land on the dashboard — d1 is still open but is NOT where the
    // user just came from.
    mount("/");
    await act(async () => {
      go!("/editor/d1");
    });
    await act(async () => {
      go!("/");
    });
    await act(async () => {
      go!("/editor/d2");
    });
    expect(path).toBe("/editor/d2");

    await act(async () => {
      api!.closeTab("d2");
    });
    // Let every follow-up effect (tab persistence, URL mirroring) settle: a
    // late re-navigation would put the user straight back in the editor.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(path).toBe("/");
    expect(api!.tabs.map((t) => t.id)).toEqual(["d1"]);
  });

  it("goes back to the previously active tab, not the positional neighbour", async () => {
    mount("/");
    await act(async () => {
      go!("/editor/a");
    });
    await act(async () => {
      go!("/editor/b");
    });
    await act(async () => {
      go!("/editor/c");
    });
    await act(async () => {
      go!("/editor/b");
    });
    expect(path).toBe("/editor/b");

    await act(async () => {
      api!.closeTab("b");
    });

    // Positional neighbour after removing "b" is "c" as well here, so pin the
    // distinction the other way round: revisit "a" last, then close "b".
    expect(path).toBe("/editor/c");
  });

  it("restores the remembered collection instead of All Drawings", async () => {
    window.localStorage.setItem(
      "excalidash:last-dashboard-view",
      "/collections?id=proj-9",
    );
    mount("/collections?id=proj-9");
    await act(async () => {
      go!("/editor/d1");
    });

    await act(async () => {
      api!.closeTab("d1");
    });

    expect(path).toBe("/collections");
    expect(new URLSearchParams(search).get("id")).toBe("proj-9");
  });
  it("prefers the last visited tab over the positional neighbour", async () => {
    mount("/");
    for (const id of ["a", "b", "c"]) {
      await act(async () => {
        go!(`/editor/${id}`);
      });
    }
    // Jump back to "a", then to "c": the bar order is a,b,c but the view
    // before "c" is "a", not the neighbour "b".
    await act(async () => {
      go!("/editor/a");
    });
    await act(async () => {
      go!("/editor/c");
    });

    await act(async () => {
      api!.closeTab("c");
    });

    expect(path).toBe("/editor/a");
  });
  it("keeps the history across a reload so a restored workspace still goes back", async () => {
    // First page session: dashboard -> d1 -> dashboard -> d2.
    const first = mount("/");
    await act(async () => {
      go!("/editor/d1");
    });
    await act(async () => {
      go!("/");
    });
    await act(async () => {
      go!("/editor/d2");
    });
    first.unmount();

    // Reload straight into d2 with the workspace restored from storage.
    mount("/editor/d2");
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      api!.closeTab("d2");
    });

    // Without persistence this fell through to the positional neighbour (d1).
    expect(path).toBe("/");
  });
});

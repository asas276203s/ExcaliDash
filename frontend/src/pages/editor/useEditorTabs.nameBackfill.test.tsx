/**
 * Tabs restored from localStorage were never named: `updateTabName` only ever
 * fired for the drawing currently loaded in the editor, so every other tab
 * rendered as a truncated uuid ("86cc5e94…"). These cover the back-fill.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getDrawingSummariesByIds = vi.fn();
vi.mock("../../api", () => ({
  get getDrawingSummariesByIds() {
    return getDrawingSummariesByIds;
  },
}));

const updateTabName = vi.fn();
let tabs: Array<{ id: string; name?: string }> = [];

vi.mock("../../context/TabsContext", () => ({
  useTabsContext: () => ({
    tabs,
    updateTabName,
    closeTab: vi.fn(),
    reopenLastClosed: vi.fn(),
    activeId: null,
    hasClosedHistory: false,
  }),
}));

vi.mock("./useTabsKeyboard", () => ({ useTabsKeyboard: () => {} }));

import { useEditorTabs } from "./useEditorTabs";

const render = () =>
  renderHook(() => useEditorTabs({ drawingId: "a", drawingName: "A" }));

describe("useEditorTabs name back-fill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDrawingSummariesByIds.mockResolvedValue([]);
    tabs = [];
  });

  it("fetches names for unnamed tabs in ONE batched request", async () => {
    tabs = [
      { id: "named", name: "Already Known" },
      { id: "bare-1" },
      { id: "bare-2" },
    ];
    getDrawingSummariesByIds.mockResolvedValue([
      { id: "bare-1", name: "Refund Flow" },
      { id: "bare-2", name: "TapPay Flow" },
    ]);

    render();

    await waitFor(() => expect(getDrawingSummariesByIds).toHaveBeenCalledTimes(1));
    // Only the unnamed ids, and the already-named tab is left alone.
    expect(getDrawingSummariesByIds.mock.calls[0][0]).toEqual(["bare-1", "bare-2"]);

    await waitFor(() => {
      expect(updateTabName).toHaveBeenCalledWith("bare-1", "Refund Flow");
      expect(updateTabName).toHaveBeenCalledWith("bare-2", "TapPay Flow");
    });
    expect(updateTabName).not.toHaveBeenCalledWith("named", expect.anything());
  });

  it("does not fetch when every tab already has a name", async () => {
    tabs = [
      { id: "x", name: "One" },
      { id: "y", name: "Two" },
    ];
    render();
    await Promise.resolve();
    expect(getDrawingSummariesByIds).not.toHaveBeenCalled();
  });

  it("does not refetch an id the server omitted (no access) on rerender", async () => {
    tabs = [{ id: "forbidden" }];
    getDrawingSummariesByIds.mockResolvedValue([]); // server filtered it out

    const { rerender } = render();
    await waitFor(() => expect(getDrawingSummariesByIds).toHaveBeenCalledTimes(1));

    tabs = [{ id: "forbidden" }, { id: "fresh" }];
    rerender();

    await waitFor(() => expect(getDrawingSummariesByIds).toHaveBeenCalledTimes(2));
    // The second call must ask only for the NEW id, never re-ask for the one
    // the server already declined.
    expect(getDrawingSummariesByIds.mock.calls[1][0]).toEqual(["fresh"]);
  });

  it("keeps the uuid fallback and allows a retry when the request fails", async () => {
    tabs = [{ id: "flaky" }];
    getDrawingSummariesByIds.mockRejectedValueOnce(new Error("network"));

    const { rerender } = render();
    await waitFor(() => expect(getDrawingSummariesByIds).toHaveBeenCalledTimes(1));
    // (the sibling effect still names the *current* drawing — only assert that
    // the failed back-fill produced no name for its own id)
    expect(updateTabName).not.toHaveBeenCalledWith("flaky", expect.anything());

    // Guard cleared on failure -> a later tabs change retries the same id.
    getDrawingSummariesByIds.mockResolvedValue([{ id: "flaky", name: "Recovered" }]);
    tabs = [{ id: "flaky" }, { id: "other", name: "Other" }];
    rerender();

    await waitFor(() =>
      expect(updateTabName).toHaveBeenCalledWith("flaky", "Recovered"),
    );
  });
});

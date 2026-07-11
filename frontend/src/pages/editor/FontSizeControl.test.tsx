import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock the heavy excalidraw UI bundle — we only need the three helpers the
// component imports, and we want deterministic, dependency-free behavior.
vi.mock("@excalidraw/excalidraw", () => ({
  restoreElements: (els: any[]) => els,
  newElementWith: (el: any, updates: any) => ({ ...el, ...updates }),
  CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY", NEVER: "NEVER" },
}));

import { FontSizeControl } from "./FontSizeControl";

const text = (id: string, fontSize: number, extra: Record<string, any> = {}) => ({
  id,
  type: "text",
  fontSize,
  ...extra,
});

type MockScene = {
  elements: any[];
  selectedElementIds: Record<string, boolean>;
};

const makeApi = (scene: MockScene) => {
  const updateScene = vi.fn((data: any) => {
    if (Array.isArray(data.elements)) scene.elements = data.elements;
  });
  return {
    ref: {
      current: {
        getSceneElements: () => scene.elements,
        getAppState: () => ({ selectedElementIds: scene.selectedElementIds }),
        updateScene,
      },
    },
    updateScene,
    scene,
  };
};

const renderControl = (scene: MockScene, canEdit = true) => {
  const api = makeApi(scene);
  const utils = render(
    <FontSizeControl
      excalidrawAPIRef={api.ref as any}
      appState={{ selectedElementIds: scene.selectedElementIds }}
      canEdit={canEdit}
    />,
  );
  return { ...api, ...utils };
};

describe("FontSizeControl", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders nothing when no text is selected", () => {
    renderControl({ elements: [{ id: "r", type: "rectangle" }], selectedElementIds: { r: true } });
    expect(screen.queryByTestId("font-size-control")).toBeNull();
  });

  it("renders nothing in read-only mode", () => {
    renderControl(
      { elements: [text("a", 20)], selectedElementIds: { a: true } },
      false,
    );
    expect(screen.queryByTestId("font-size-control")).toBeNull();
  });

  it("shows the current px value for a selected text element", () => {
    renderControl({ elements: [text("a", 28)], selectedElementIds: { a: true } });
    const input = screen.getByTestId("font-size-input") as HTMLInputElement;
    expect(input.value).toBe("28");
  });

  it("shows the 混合 placeholder for a mixed selection", () => {
    renderControl({
      elements: [text("a", 20), text("b", 28)],
      selectedElementIds: { a: true, b: true },
    });
    const input = screen.getByTestId("font-size-input") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("混合");
  });

  it("applies a typed value on Enter", () => {
    const { updateScene, scene } = renderControl({
      elements: [text("a", 20)],
      selectedElementIds: { a: true },
    });
    const input = screen.getByTestId("font-size-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "32" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(updateScene).toHaveBeenCalledTimes(1);
    expect(scene.elements.find((e) => e.id === "a").fontSize).toBe(32);
  });

  it("does NOT apply on Enter while the IME is composing", () => {
    const { updateScene } = renderControl({
      elements: [text("a", 20)],
      selectedElementIds: { a: true },
    });
    const input = screen.getByTestId("font-size-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "32" } });
    // isComposing=true simulates a mid-注音 composition.
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(updateScene).not.toHaveBeenCalled();
  });

  it("nudges +1 on ArrowUp and +4 on Shift+ArrowUp", () => {
    const { updateScene, scene } = renderControl({
      elements: [text("a", 20)],
      selectedElementIds: { a: true },
    });
    const input = screen.getByTestId("font-size-input");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(scene.elements.find((e) => e.id === "a").fontSize).toBe(21);
    fireEvent.keyDown(input, { key: "ArrowUp", shiftKey: true });
    expect(scene.elements.find((e) => e.id === "a").fontSize).toBe(25);
    expect(updateScene).toHaveBeenCalledTimes(2);
  });

  it("unifies a mixed selection to the typed value", () => {
    const { scene } = renderControl({
      elements: [text("a", 20), text("b", 28)],
      selectedElementIds: { a: true, b: true },
    });
    const input = screen.getByTestId("font-size-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "40" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(scene.elements.find((e) => e.id === "a").fontSize).toBe(40);
    expect(scene.elements.find((e) => e.id === "b").fontSize).toBe(40);
  });

  it("strips non-digits from typed input", () => {
    renderControl({ elements: [text("a", 20)], selectedElementIds: { a: true } });
    const input = screen.getByTestId("font-size-input") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "3a4!" } });
    expect(input.value).toBe("34");
  });
});

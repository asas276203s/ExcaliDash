import { test, expect } from "@playwright/test";
import { createDrawing, deleteDrawing, getDrawing } from "./helpers/api";

/**
 * Verifies the custom floating font-size control:
 *  - appears only when a text element is selected
 *  - shows the current font size in px
 *  - applies a typed value on Enter and recomputes the text bounding box
 *  - persists the change across a reload
 *  - shows "混合" for a mixed-size multi-selection and unifies on apply
 *
 * Selection is driven through the dev-exposed excalidraw API on window so the
 * test does not depend on canvas hit-testing coordinates.
 */
test.describe("Font size control", () => {
  let createdIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdIds) {
      try {
        await deleteDrawing(request, id);
      } catch {
        /* ignore */
      }
    }
    createdIds = [];
  });

  const gotoEditor = async (page: any, id: string) => {
    await page.goto(`/editor/${id}`);
    await page.waitForSelector("canvas.excalidraw__canvas.interactive", {
      timeout: 15000,
    });
    await page.waitForTimeout(1200);
    await page.waitForFunction(
      () => !!(window as any).__EXCALIDASH_EXCALIDRAW_API__,
      { timeout: 15000 },
    );
  };

  /** Insert one or more text elements into the live scene via the dev API. */
  const insertTextElements = async (
    page: any,
    specs: Array<{ id: string; fontSize: number; text: string; y: number }>,
  ) => {
    await page.evaluate((specs: any[]) => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      const base = api.getSceneElements();
      const now = Date.now();
      const els = specs.map((s, i) => ({
        id: s.id,
        type: "text",
        x: 200,
        y: s.y,
        width: 120,
        height: s.fontSize * 1.25,
        angle: 0,
        strokeColor: "#1e1e1e",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 1 + i,
        version: 1,
        versionNonce: 1 + i,
        isDeleted: false,
        boundElements: null,
        updated: now,
        link: null,
        locked: false,
        text: s.text,
        fontSize: s.fontSize,
        fontFamily: 1,
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        originalText: s.text,
        lineHeight: 1.25,
        baseline: s.fontSize,
        // Free (auto-resizing) text — matches a text-tool element and lets
        // refreshTextDimensions recompute width AND height on a font change.
        autoResize: true,
      }));
      api.updateScene({ elements: [...base, ...els] });
    }, specs);
    await page.waitForTimeout(300);
  };

  const selectIds = async (page: any, ids: string[]) => {
    await page.evaluate((ids: string[]) => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      api.updateScene({
        appState: {
          selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])),
        },
      });
    }, ids);
    await page.waitForTimeout(200);
  };

  const readElement = (page: any, id: string) =>
    page.evaluate((id: string) => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      const el = api
        .getSceneElements()
        .find((e: any) => e.id === id);
      return el ? { fontSize: el.fontSize, height: el.height, width: el.width } : null;
    }, id);

  test("shows px, applies a typed value, recomputes size, and persists", async ({
    page,
    request,
  }) => {
    const drawing = await createDrawing(request, {
      name: `FontSize_${Date.now()}`,
      elements: [],
    });
    createdIds.push(drawing.id);

    await gotoEditor(page, drawing.id);
    await insertTextElements(page, [
      { id: "txt-1", fontSize: 20, text: "Hello", y: 200 },
    ]);

    const control = page.getByTestId("font-size-control");
    const input = page.getByTestId("font-size-input");

    // Hidden until a text element is selected.
    await expect(control).toHaveCount(0);

    await selectIds(page, ["txt-1"]);
    await expect(control).toBeVisible();
    await expect(input).toHaveValue("20");

    const before = await readElement(page, "txt-1");

    // Type 36 + Enter.
    await input.click();
    await input.fill("36");
    await input.press("Enter");
    await page.waitForTimeout(400);

    const after = await readElement(page, "txt-1");
    expect(after.fontSize).toBe(36);
    // Bounding box must grow with a larger font size (dimensions recomputed).
    expect(after.height).toBeGreaterThan(before.height);
    expect(after.width).not.toBe(before.width);

    // Persist: force an autosave then reload and read from the backend.
    await page.waitForTimeout(1500);
    await page.reload();
    await gotoEditor(page, drawing.id);
    const persisted = await getDrawing(request, drawing.id);
    const persistedText = (persisted.elements as any[]).find(
      (e) => e.id === "txt-1",
    );
    expect(persistedText?.fontSize).toBe(36);
  });

  test("shows 混合 for a mixed selection and unifies on apply", async ({
    page,
    request,
  }) => {
    const drawing = await createDrawing(request, {
      name: `FontMixed_${Date.now()}`,
      elements: [],
    });
    createdIds.push(drawing.id);

    await gotoEditor(page, drawing.id);
    await insertTextElements(page, [
      { id: "m-1", fontSize: 16, text: "A", y: 160 },
      { id: "m-2", fontSize: 28, text: "B", y: 260 },
    ]);

    const input = page.getByTestId("font-size-input");
    await selectIds(page, ["m-1", "m-2"]);
    await expect(input).toHaveValue("");
    await expect(input).toHaveAttribute("placeholder", "混合");

    await input.click();
    await input.fill("24");
    await input.press("Enter");
    await page.waitForTimeout(400);

    expect((await readElement(page, "m-1")).fontSize).toBe(24);
    expect((await readElement(page, "m-2")).fontSize).toBe(24);
  });

  test("stays hidden when a non-text element is selected", async ({
    page,
    request,
  }) => {
    const drawing = await createDrawing(request, {
      name: `FontRect_${Date.now()}`,
      elements: [],
    });
    createdIds.push(drawing.id);

    await gotoEditor(page, drawing.id);
    await page.evaluate(() => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      const now = Date.now();
      api.updateScene({
        elements: [
          {
            id: "rect-1",
            type: "rectangle",
            x: 200,
            y: 200,
            width: 120,
            height: 80,
            angle: 0,
            strokeColor: "#1e1e1e",
            backgroundColor: "transparent",
            fillStyle: "solid",
            strokeWidth: 1,
            strokeStyle: "solid",
            roughness: 1,
            opacity: 100,
            groupIds: [],
            frameId: null,
            roundness: null,
            seed: 1,
            version: 1,
            versionNonce: 1,
            isDeleted: false,
            boundElements: null,
            updated: now,
            link: null,
            locked: false,
          },
        ],
      });
    });
    await page.waitForTimeout(300);
    await selectIds(page, ["rect-1"]);
    await expect(page.getByTestId("font-size-control")).toHaveCount(0);
  });
});

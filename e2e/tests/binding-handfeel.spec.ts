import { test, expect } from "@playwright/test";
import { createDrawing, deleteDrawing, getDrawing } from "./helpers/api";

/**
 * Binding hand-feel verification for the excalidraw canary upgrade.
 * Draws two rectangles, then an arrow from A to B, and asserts the arrow
 * acquires startBinding + endBinding (the "arrow focuses on the node" UX).
 *
 * Screen coordinates for the arrow are computed from the LIVE excalidraw
 * appState (scroll/zoom) exposed on window in dev, so the arrow reliably lands
 * on the shapes regardless of any canvas auto-scroll.
 */
test.describe("Excalidraw canary binding UX", () => {
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

  test("arrow from A to B acquires start/end bindings", async ({ page, request }) => {
    const drawing = await createDrawing(request, {
      name: `Binding_${Date.now()}`,
      elements: [],
    });
    createdIds.push(drawing.id);

    await page.goto(`/editor/${drawing.id}`);
    await page.waitForSelector("[class*='excalidraw'], canvas", { timeout: 15000 });
    await page.waitForTimeout(1500);

    const canvas = page.locator("canvas.excalidraw__canvas.interactive");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Canvas not found");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    const drawRect = async (x1: number, y1: number, x2: number, y2: number) => {
      await page.locator('label:has([data-testid="toolbar-rectangle"])').click();
      await page.waitForTimeout(200);
      await page.mouse.move(x1, y1);
      await page.mouse.down();
      await page.mouse.move(x2, y2, { steps: 15 });
      await page.mouse.up();
      await page.waitForTimeout(300);
    };

    // Two rectangles, left and right of centre.
    await drawRect(cx - 320, cy - 60, cx - 160, cy + 60);
    await drawRect(cx + 160, cy - 60, cx + 320, cy + 60);
    await page.keyboard.press("Escape");
    // Let any autosave / auto-scroll settle before we read scene geometry.
    await page.waitForTimeout(2500);

    // Read the two rectangles' live viewport-space edge midpoints from the
    // excalidraw API (dev-exposed on window). This makes the arrow land on the
    // shapes no matter how the canvas scrolled.
    const anchors = await page.evaluate(() => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      if (!api) throw new Error("excalidraw API not exposed on window");
      const st = api.getAppState();
      const zoom = st.zoom?.value ?? 1;
      const toViewport = (sx: number, sy: number) => ({
        x: (sx + st.scrollX) * zoom + (st.offsetLeft ?? 0),
        y: (sy + st.scrollY) * zoom + (st.offsetTop ?? 0),
      });
      const rects = api
        .getSceneElements()
        .filter((e: any) => e.type === "rectangle" && !e.isDeleted)
        .sort((a: any, b: any) => a.x - b.x);
      if (rects.length < 2) throw new Error(`expected 2 rects, got ${rects.length}`);
      const [a, b] = rects;
      return {
        aRightMid: toViewport(a.x + a.width, a.y + a.height / 2),
        aCenter: toViewport(a.x + a.width / 2, a.y + a.height / 2),
        bLeftMid: toViewport(b.x, b.y + b.height / 2),
        bCenter: toViewport(b.x + b.width / 2, b.y + b.height / 2),
      };
    });

    // Arrow tool: start on A's right edge (hover so start-binding registers),
    // drag through empty space, release over B's centre (end-binding).
    await page.locator('label:has([data-testid="toolbar-arrow"])').click();
    await page.waitForTimeout(200);
    // Hover the start shape first so excalidraw highlights the bind target.
    await page.mouse.move(anchors.aRightMid.x - 4, anchors.aRightMid.y);
    await page.waitForTimeout(120);
    await page.mouse.down();
    await page.mouse.move((anchors.aRightMid.x + anchors.bLeftMid.x) / 2, anchors.aRightMid.y, {
      steps: 10,
    });
    // End over B's centre so the end binds and "focuses" toward the node middle.
    await page.mouse.move(anchors.bCenter.x, anchors.bCenter.y, { steps: 15 });
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(400);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    await page.screenshot({ path: "test-results/binding-handfeel.png" });

    // Read the LIVE arrow binding straight from the API too (authoritative),
    // then also confirm it persisted through the save round-trip.
    const live = await page.evaluate(() => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      const arrow = api.getSceneElements().find((e: any) => e.type === "arrow" && !e.isDeleted);
      return arrow
        ? {
            startBinding: arrow.startBinding,
            endBinding: arrow.endBinding,
          }
        : null;
    });
    console.log("LIVE ARROW BINDING:", JSON.stringify(live, null, 2));

    await expect
      .poll(
        async () => {
          const saved = await getDrawing(request, drawing.id);
          const arrow = (saved.elements || []).find((e: any) => e.type === "arrow");
          return arrow ? Boolean(arrow.startBinding && arrow.endBinding) : false;
        },
        { timeout: 15000 },
      )
      .toBe(true);

    const saved = await getDrawing(request, drawing.id);
    const els = (saved.elements || []) as any[];
    const arrow = els.find((e) => e.type === "arrow");
    const rectIds = new Set(els.filter((e) => e.type === "rectangle").map((e) => e.id));
    console.log("PERSISTED ARROW BINDING:", JSON.stringify({
      startBinding: arrow?.startBinding,
      endBinding: arrow?.endBinding,
    }, null, 2));

    expect(arrow, "arrow persisted").toBeTruthy();
    expect(arrow.startBinding, "start bound").toBeTruthy();
    expect(arrow.endBinding, "end bound").toBeTruthy();
    expect(rectIds.has(arrow.startBinding.elementId)).toBe(true);
    expect(rectIds.has(arrow.endBinding.elementId)).toBe(true);

    // A binding is valid if it carries EITHER the legacy focus/gap model OR the
    // canary fixedPoint/mode model (the new "arrow anchors to a fixed relative
    // point on the node" UX). Assert each end has a usable binding shape.
    const isBound = (b: any) =>
      typeof b?.focus === "number" ||
      (Array.isArray(b?.fixedPoint) && b.fixedPoint.length === 2);
    expect(isBound(arrow.startBinding), "start binding has focus or fixedPoint").toBe(true);
    expect(isBound(arrow.endBinding), "end binding has focus or fixedPoint").toBe(true);

    // The end was released over B's centre — the canary should focus the arrow
    // toward the node middle (~[0.5, 0.5]) when fixedPoint binding is used.
    if (Array.isArray(arrow.endBinding.fixedPoint)) {
      const [fx, fy] = arrow.endBinding.fixedPoint;
      expect(Math.abs(fx - 0.5)).toBeLessThan(0.25);
      expect(Math.abs(fy - 0.5)).toBeLessThan(0.25);
    }
  });
});

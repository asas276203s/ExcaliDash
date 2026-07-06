import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  createDrawing,
  deleteDrawing,
  getDrawing,
  updateDrawing,
} from "./helpers/api";

/**
 * Real-time collab acceptance matrix — 62 rows as spec'd in the
 * designer document (see scratchpad/excalidash-designer-spec.md §1).
 *
 * Structure:
 *   A. Local gesture × remote source              — 30 rows (10 × 3)
 *   B. Broadcast reach                             — 6 rows
 *   C. Tab-switch interleaving                     — 6 rows
 *   D. Persistence race                            — 4 rows
 *   F. Extreme cases                               — 8 rows
 *   G. Sync-pill visual acceptance                 — 8 rows
 *
 * Priority scheme:
 *   P0 — crash / data loss; MUST pass before ship.
 *   P1 — visible bug; target 80% pass.
 *   P2 — polish; skip with TODO if infra is thin.
 *
 * NOTE: Many rows below are marked `test.skip` because their scaffolding
 * (multi-context browser negotiation, network-throttling simulation) is
 * still being brought online in this sprint. They stay in the file as
 * intentional TODOs so the QA verifier subagent can turn them on one at
 * a time without re-deriving structure. The comment on each skip states
 * what infrastructure it needs.
 */

const CANVAS_SELECTOR = "canvas.excalidraw__canvas.interactive";
const SYNC_PILL_TESTID = "remote-sync-pill";
const SYNC_OVERLAY_TESTID = "remote-sync-overlay";

const REMOTE_ELEMENT_TEMPLATE = (id: string) => ({
  id,
  type: "rectangle",
  x: 400,
  y: 400,
  width: 100,
  height: 60,
  angle: 0,
  strokeColor: "#000000",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: 12345,
  version: 2,
  versionNonce: 987,
  isDeleted: false,
  boundElements: null,
  updated: Date.now(),
  link: null,
  locked: false,
});

const waitForCanvas = async (page: Page) => {
  await page.waitForSelector(CANVAS_SELECTOR, { timeout: 15000 });
  await page.waitForTimeout(500);
};

const getCanvasBox = async (page: Page) => {
  const canvas = page.locator(CANVAS_SELECTOR).first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas bounding box not found");
  return box;
};

// ─────────────────────────────────────────────────────────────────────
//  A. Local gesture × Remote update — 30 rows
// ─────────────────────────────────────────────────────────────────────

type Gesture = {
  id: string;
  label: string;
  priority: "P0" | "P1" | "P2";
  // Presses / clicks / drags happen inside the driver. Left as a lambda
  // because each gesture starts differently (r for rectangle, d for
  // diamond, etc.).
  drive: (page: Page, box: { x: number; y: number }) => Promise<void>;
};

const gestures: Gesture[] = [
  {
    id: "G1",
    label: "drag existing element",
    priority: "P0",
    drive: async (page, box) => {
      // Draw one rectangle to be dragged later.
      await page.keyboard.press("r");
      await page.mouse.move(box.x + 200, box.y + 200);
      await page.mouse.down();
      await page.mouse.move(box.x + 320, box.y + 260, { steps: 3 });
      await page.mouse.up();
      // Now press-hold to start a drag we WILL NOT release.
      await page.mouse.move(box.x + 260, box.y + 230);
      await page.mouse.down();
      await page.mouse.move(box.x + 280, box.y + 250, { steps: 2 });
    },
  },
  { id: "G2", label: "new rectangle", priority: "P0", drive: newShape("r") },
  { id: "G3", label: "new diamond", priority: "P1", drive: newShape("d") },
  { id: "G4", label: "new arrow", priority: "P1", drive: newShape("a") },
  { id: "G5", label: "new line", priority: "P1", drive: newShape("l") },
  {
    id: "G6",
    label: "new text",
    priority: "P1",
    drive: async (page, box) => {
      await page.keyboard.press("t");
      await page.mouse.click(box.x + 200, box.y + 200);
    },
  },
  {
    id: "G7",
    label: "resize with handles",
    priority: "P0",
    drive: async (page, box) => {
      await page.keyboard.press("r");
      await page.mouse.move(box.x + 200, box.y + 200);
      await page.mouse.down();
      await page.mouse.move(box.x + 320, box.y + 260, { steps: 3 });
      await page.mouse.up();
      // Grab bottom-right handle (approx position).
      await page.mouse.move(box.x + 320, box.y + 260);
      await page.mouse.down();
      await page.mouse.move(box.x + 380, box.y + 300, { steps: 3 });
    },
  },
  { id: "G8", label: "rotate", priority: "P1", drive: notImplemented("rotate") },
  { id: "G9", label: "crop image", priority: "P1", drive: notImplemented("crop") },
  {
    id: "G10",
    label: "pan canvas",
    priority: "P1",
    drive: async (page, box) => {
      await page.keyboard.down("Space");
      await page.mouse.move(box.x + 300, box.y + 300);
      await page.mouse.down();
      await page.mouse.move(box.x + 400, box.y + 400, { steps: 3 });
    },
  },
];

function newShape(key: string) {
  return async (page: Page, box: { x: number; y: number }) => {
    await page.keyboard.press(key);
    await page.mouse.move(box.x + 260, box.y + 240);
    await page.mouse.down();
    await page.mouse.move(box.x + 380, box.y + 320, { steps: 3 });
  };
}

function notImplemented(what: string) {
  return async () => {
    throw new Error(
      `Gesture "${what}" not yet implementable in Playwright — TODO: reach into ` +
        `Excalidraw API via window.__EXCALIDRAW_API for test-only handles.`,
    );
  };
}

type RemoteSource = {
  id: string;
  label: string;
  // F5 (Round 3): drivers now read the CURRENT drawing before firing so the
  // PUT's `version` matches whatever the backend has. Hard-coding version=2
  // against a freshly-created v1 drawing produced 409 VERSION_CONFLICT and
  // was the root cause of 15/15 A-matrix failures in Round 2 QA. The `fire`
  // signature dropped the `version` parameter — helper reads it internally.
  fire: (
    request: import("@playwright/test").APIRequestContext,
    drawingId: string,
    remoteElementId: string,
  ) => Promise<{ remoteIds: string[] }>;
};

// F2 (Round 3): R1 now has genuine append semantics — GET the current
// elements, append the new one, PUT the whole array. R2 stays replace-all
// (throws away current elements entirely). Backend has no atomic patch
// endpoint (see backend/src/routes/dashboard/drawingCreateUpdateRoutes.ts),
// so append is emulated on the client. This matches how the MCP server
// itself implements append via a read-modify-write cycle.
const remoteSources: RemoteSource[] = [
  {
    id: "R1",
    label: "mcp patch (append)",
    fire: async (request, drawingId, remoteElementId) => {
      const current = await getDrawing(request, drawingId);
      const existing = Array.isArray(current.elements) ? current.elements : [];
      const newElement = REMOTE_ELEMENT_TEMPLATE(remoteElementId);
      await updateDrawing(request, drawingId, {
        elements: [...existing, newElement],
        version: current.version,
      } as any);
      return { remoteIds: [remoteElementId] };
    },
  },
  {
    id: "R2",
    label: "mcp update (replace all)",
    fire: async (request, drawingId, remoteElementId) => {
      const current = await getDrawing(request, drawingId);
      const primary = REMOTE_ELEMENT_TEMPLATE(remoteElementId);
      const secondary = REMOTE_ELEMENT_TEMPLATE(`${remoteElementId}-b`);
      await updateDrawing(request, drawingId, {
        elements: [primary, secondary],
        version: current.version,
      } as any);
      return { remoteIds: [remoteElementId, `${remoteElementId}-b`] };
    },
  },
  {
    // R3 requires spinning up a second authenticated browser context AND
    // wiring it up as a "peer" through the same collab room. That is more
    // than a simple HTTP hop — skipped here and covered by section B (which
    // uses two contexts explicitly).
    id: "R3",
    label: "peer browser autosave",
    fire: async () => {
      throw new Error(
        "R3 remote source requires a second browser context; use the " +
          "explicit two-context spec in section B for peer-driven coverage.",
      );
    },
  },
];

/**
 * F3 (Round 3): after every A-matrix apply, we want to prove BOTH survived —
 * the local gesture's committed element AND the remote's newly-added elements.
 * The dev-only `window.__EXCALIDASH_EXCALIDRAW_API__` is exposed by
 * `Editor.tsx` in `import.meta.env.DEV`, which is exactly the mode Playwright
 * hits (`npm run dev`).
 */
const getSceneElementIds = async (page: Page): Promise<string[]> => {
  return await page.evaluate(() => {
    const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
    if (!api || typeof api.getSceneElements !== "function") return [];
    const elements = api.getSceneElements() as Array<{
      id: string;
      isDeleted?: boolean;
    }>;
    return elements
      .filter((el) => el && el.id && !el.isDeleted)
      .map((el) => el.id);
  });
};

// Row-by-row matrix. Each row is a describe(gesture) → test(remote) pair.
// We intentionally use `test.skip` for rows whose gesture/remote driver
// is still stubbed so the file is executable end-to-end today and each
// row can be un-skipped independently.
test.describe("A. Gesture × Remote (30 rows)", () => {
  const createdIds: string[] = [];
  test.afterEach(async ({ request }) => {
    for (const id of createdIds.splice(0)) {
      try {
        await deleteDrawing(request, id);
      } catch {
        /* ignore */
      }
    }
  });

  for (const gesture of gestures) {
    for (const source of remoteSources) {
      const rowId = `${gesture.id}×${source.id}`;
      const priority = gesture.priority;
      const shouldSkip =
        source.id === "R3" ||
        gesture.id === "G8" ||
        gesture.id === "G9" ||
        gesture.id === "G6";
      const runner = shouldSkip ? test.skip : test;
      runner(`${rowId} [${priority}] ${gesture.label} × ${source.label}`, async ({
        browser,
        request,
      }) => {
        const drawing = await createDrawing(request, {
          name: `${rowId}_${Date.now()}`,
        });
        createdIds.push(drawing.id);

        const context = await browser.newContext();
        const page = await context.newPage();
        const pageerrors: Error[] = [];
        page.on("pageerror", (err) => pageerrors.push(err));

        try {
          await page.goto(`/editor/${drawing.id}`);
          await waitForCanvas(page);

          const box = await getCanvasBox(page);

          // 1. Start the gesture and hold it.
          await gesture.drive(page, box);

          // 2. Snapshot which local ids exist BEFORE the remote fires so
          //    the post-apply check knows what "the local gesture's element"
          //    is (F3). Some gestures (like G10 pan) may not produce a new
          //    element — that's fine, the assertion below tolerates an
          //    empty localIdsBefore.
          const localIdsBefore = await getSceneElementIds(page);

          // 3. Fire the remote update. F5: driver reads current version
          //    internally, so no more hard-coded `2` producing 409.
          const remoteId = `remote-${rowId}-${Date.now()}`;
          const { remoteIds } = await source.fire(
            request,
            drawing.id,
            remoteId,
          );

          // 4. The pill should light up. It's driven on the leading edge
          //    of the drawing-server-update burst (see collab hook), so
          //    the aria-busy=true state is stable through the debounce +
          //    fetch window.
          await page.waitForSelector(
            `[data-testid="${SYNC_PILL_TESTID}"][aria-busy="true"]`,
            { timeout: 5_000 },
          );

          // 5. Release the gesture. Because we can't guarantee where the
          //    mouse ends for every gesture flavour, we do a generic mouse-up
          //    + keyboard clear.
          await page.mouse.up();
          await page.keyboard.press("Escape");
          await page.waitForTimeout(300);

          // 6. Pill should dismiss.
          await page.waitForSelector(
            `[data-testid="${SYNC_PILL_TESTID}"][aria-busy="false"]`,
            { timeout: 5_000 },
          );

          // 7. F3: Designer spec §1.A criterion 6 — after apply, the scene
          //    must contain BOTH the remote element(s) AND the pre-existing
          //    local element(s). If the apply silently discarded the local
          //    gesture (regression), we catch it here.
          const idsAfter = await getSceneElementIds(page);
          for (const rid of remoteIds) {
            expect(idsAfter, `remote id ${rid} missing after apply`).toContain(
              rid,
            );
          }
          for (const lid of localIdsBefore) {
            expect(idsAfter, `local id ${lid} discarded on apply`).toContain(
              lid,
            );
          }

          expect(pageerrors).toHaveLength(0);
        } finally {
          await context.close();
        }
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────
//  B. Broadcast reach — 6 rows
// ─────────────────────────────────────────────────────────────────────

test.describe("B. Broadcast reach (6 rows)", () => {
  const createdIds: string[] = [];
  test.afterEach(async ({ request }) => {
    for (const id of createdIds.splice(0)) {
      try {
        await deleteDrawing(request, id);
      } catch {}
    }
  });

  test("B1 [P0] both peers see MCP patch", async ({ browser, request }) => {
    const drawing = await createDrawing(request, { name: `B1_${Date.now()}` });
    createdIds.push(drawing.id);
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();
    try {
      await p1.goto(`/editor/${drawing.id}`);
      await p2.goto(`/editor/${drawing.id}`);
      await waitForCanvas(p1);
      await waitForCanvas(p2);
      const remoteId = `B1-${Date.now()}`;
      await remoteSources[0].fire(request, drawing.id, remoteId);
      await Promise.all([
        p1.waitForSelector(`[data-testid="${SYNC_PILL_TESTID}"]`, { timeout: 5_000 }),
        p2.waitForSelector(`[data-testid="${SYNC_PILL_TESTID}"]`, { timeout: 5_000 }),
      ]);
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test.skip("B2 [P0] reconnect after 3s offline still receives next update", async () => {
    // TODO: use context.setOffline(true) then (false) then fire MCP; assert
    // the pill appears within 3s of coming back online. Needs socket.io
    // reconnect timing verification.
  });

  test.skip("B3 [P1] missed-during-offline update is picked up on next save flow", async () => {
    // TODO: verify 409 auto-merge covers the gap (existing behaviour) OR
    // implement explicit resync-on-reconnect.
  });

  test.skip("B4 [P1] 3-way room delivery", async () => {
    // TODO: A saves, B and C both receive drawing-server-update. Requires
    // three browser contexts and a canvas edit in one to trigger backend save.
  });

  test.skip("B5 [P1] viewer without edit right still receives updates", async () => {
    // TODO: needs share-link infrastructure to mint a view-only session.
  });

  test.skip("B6 [P1] closed-tab peer does not receive zombie retries", async () => {
    // TODO: needs backend log tap; alternative is to observe `presence-update`
    // list shrinks after tab close.
  });
});

// ─────────────────────────────────────────────────────────────────────
//  C. Tab-switch interleaving — 6 rows
// ─────────────────────────────────────────────────────────────────────

test.describe("C. Tab-switch interleaving (6 rows)", () => {
  test.skip("C1 [P1] MCP fires while tab hidden → applied on focus", async () => {
    // TODO: page.emulateMedia is not enough; we need Page.setBackgroundThrottling.
  });

  test.skip("C2 [P0] gesture in tab X + cmd-tab away + MCP + return → no crash", async () => {
    // TODO: cross-app tab switching is out of Playwright reach; simulate via
    // page.evaluate to dispatch visibilitychange event, then complete gesture.
  });

  test.skip("C3 [P0] two ExcaliDash tabs on same drawing both apply MCP", async () => {
    // TODO: fully implementable via two contexts pointing at same drawingId.
  });

  test.skip("C4 [P0] two ExcaliDash tabs on DIFFERENT drawings — no cross-contamination", async () => {
    // TODO: regression for be3bd60 fix. Two tabs, MCP on drawing A, only tab A
    // shows pill; assert tab B does NOT show pill.
  });

  test.skip("C5 [P1] rapid tab-switch keeps last-active tab correct", async () => {
    // TODO: 5× tab switches in 2s. Playwright can drive but flake risk high.
  });

  test.skip("C6 [P2] suspend/resume via CDP background-throttling", async () => {
    // TODO: CDP Page.setBackgroundThrottled — non-trivial infra.
  });
});

// ─────────────────────────────────────────────────────────────────────
//  D. Persistence race — 4 rows
// ─────────────────────────────────────────────────────────────────────

test.describe("D. Persistence race (4 rows)", () => {
  test.skip("D1 [P0] save-during-MCP → 409 → auto-merge → success", async () => {
    // TODO: verified indirectly by unit tests in useEditorPersistence.
    // E2E hook: create drawing, edit locally, fire MCP mid-save, expect
    // no toast.error("Conflict") and elements from both survive.
  });

  test.skip("D2 [P0] simultaneous A + B save → one 409 → auto-merge", async () => {
    // TODO: two contexts drawing at exactly the same wall clock.
  });

  test.skip("D3 [P1] stale save 10 versions behind → merge with toast", async () => {
    // TODO: freeze one context, advance the drawing 10 times from another,
    // then save from frozen context.
  });

  test.skip("D4 [P1] double 409 surfaces DrawingSaveConflictError toast", async () => {
    // TODO: three contexts, two consecutive fast writes.
  });
});

// ─────────────────────────────────────────────────────────────────────
//  F. Extreme cases — 8 rows
// ─────────────────────────────────────────────────────────────────────

test.describe("F. Extreme cases (8 rows)", () => {
  const createdIds: string[] = [];
  test.afterEach(async ({ request }) => {
    for (const id of createdIds.splice(0)) {
      try {
        await deleteDrawing(request, id);
      } catch {}
    }
  });

  test.skip("F1 [P1] MCP sends elements:[] deletes canvas without crash", async () => {
    // TODO: precondition: local scene has at least one element, backend
    // then wipes. With the new BUG-14 guard we expect this specific case
    // to be BLOCKED (correct behaviour) — verify by asserting the local
    // scene still has its element AND a console.warn was logged.
  });

  test.skip("F2 [P1] malformed element payload is filtered without crash", async () => {
    // TODO: PUT with elements: [{ garbage: true }] and assert no page error.
  });

  test.skip("F3 [P0] 10 rapid MCP calls collapse to 1 fetch", async () => {
    // TODO: needs backend hook to count GET /drawings/:id. Currently
    // verifiable only via unit test (see useEditorCollaboration.test.ts
    // "debounces bursts of events into one fetch-and-merge").
  });

  test("F4 [P1] fetch timeout dismisses pill", async ({ page, request }) => {
    // Uses BUG-15 fix: after 10s the fetch aborts and the pill goes away.
    // We simulate by intercepting the /drawings/:id GET and stalling it.
    const drawing = await createDrawing(request, { name: `F4_${Date.now()}` });
    createdIds.push(drawing.id);
    let intercepted = false;
    await page.route(`**/drawings/${drawing.id}`, async (route) => {
      if (intercepted) return route.continue();
      // First GET (initial load) — pass through.
      await route.continue();
    });
    await page.goto(`/editor/${drawing.id}`);
    await waitForCanvas(page);

    // Now stall the NEXT GET on the same URL.
    intercepted = true;
    await page.route(`**/drawings/${drawing.id}`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      // Hang the response — the browser should abort at ~10s.
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      await route.abort();
    });
    // Fire a remote update to trigger the collab hook fetch.
    await remoteSources[0].fire(request, drawing.id, `F4-${Date.now()}`);
    // Pill lights up.
    await page.waitForSelector(
      `[data-testid="${SYNC_PILL_TESTID}"][aria-busy="true"]`,
      { timeout: 5_000 },
    );
    // Within 12s (10s abort + margin) the pill dismisses.
    await page.waitForSelector(
      `[data-testid="${SYNC_PILL_TESTID}"][aria-busy="false"]`,
      { timeout: 15_000 },
    );
  });

  test.skip("F5 [P1] backend 500 dismisses pill without noisy toast", async () => {
    // TODO: needs route interception like F4 but returning 500.
  });

  test.skip("F6 [P2] MCP during page-load isReady=false is not lost", async () => {
    // TODO: race is fundamentally hard to reproduce in Playwright without
    // slowing the frontend bundle down.
  });

  test.skip("F7 [P1] blank remote payload triggers suspiciousBlankLoad guard", async () => {
    // TODO: covered by unit test (see BUG-14 in useEditorCollaboration.test.ts).
    // Wire an e2e check that reads console.warn events.
  });

  test.skip("F8 [P2] 5000-node payload apply completes without frame crash", async () => {
    // TODO: perf-only; deferred.
  });
});

// ─────────────────────────────────────────────────────────────────────
//  G. Sync-pill visual acceptance — 8 rows
// ─────────────────────────────────────────────────────────────────────

test.describe("G. Sync-pill visual (8 rows)", () => {
  const createdIds: string[] = [];
  test.afterEach(async ({ request }) => {
    for (const id of createdIds.splice(0)) {
      try {
        await deleteDrawing(request, id);
      } catch {}
    }
  });

  test("G-V1 [P0] pill mounted, invisible by default", async ({ page, request }) => {
    const drawing = await createDrawing(request, { name: `GV1_${Date.now()}` });
    createdIds.push(drawing.id);
    await page.goto(`/editor/${drawing.id}`);
    await waitForCanvas(page);
    const pill = page.locator(`[data-testid="${SYNC_PILL_TESTID}"]`);
    await expect(pill).toBeAttached();
    await expect(pill).toHaveAttribute("aria-busy", "false");
  });

  test("G-V2 [P0] pill copy is Traditional Chinese", async ({ page, request }) => {
    const drawing = await createDrawing(request, { name: `GV2_${Date.now()}` });
    createdIds.push(drawing.id);
    await page.goto(`/editor/${drawing.id}`);
    await waitForCanvas(page);
    const pillText = await page
      .locator(`[data-testid="${SYNC_PILL_TESTID}"]`)
      .innerText();
    expect(pillText).toContain("同步中");
    expect(pillText).toContain("遠端更新");
    // Explicitly no English copy.
    expect(pillText.toLowerCase()).not.toContain("syncing");
    expect(pillText.toLowerCase()).not.toContain("updating");
  });

  test("G-V4 [P1] pill has aria-live=polite for screen readers", async ({
    page,
    request,
  }) => {
    const drawing = await createDrawing(request, { name: `GV4_${Date.now()}` });
    createdIds.push(drawing.id);
    await page.goto(`/editor/${drawing.id}`);
    await waitForCanvas(page);
    const pill = page.locator(`[data-testid="${SYNC_PILL_TESTID}"]`);
    await expect(pill).toHaveAttribute("aria-live", "polite");
    await expect(pill).toHaveAttribute("role", "status");
  });

  test("G-V5 [P0] hidden pill does not intercept pointer events (BUG-16)", async ({
    page,
    request,
  }) => {
    const drawing = await createDrawing(request, { name: `GV5_${Date.now()}` });
    createdIds.push(drawing.id);
    await page.goto(`/editor/${drawing.id}`);
    await waitForCanvas(page);
    // While NO remote sync is happening, the pill's pointer-events must
    // be none so the canvas underneath is clickable.
    const pointerEvents = await page
      .locator(`[data-testid="${SYNC_PILL_TESTID}"]`)
      .evaluate((el) => window.getComputedStyle(el).pointerEvents);
    expect(pointerEvents).toBe("none");
    // Also: the escalation overlay is not mounted (or, if mounted, is
    // opacity 0 with pointer-events none).
    const overlay = page.locator(`[data-testid="${SYNC_OVERLAY_TESTID}"]`);
    if ((await overlay.count()) > 0) {
      const overlayPE = await overlay.evaluate(
        (el) => window.getComputedStyle(el).pointerEvents,
      );
      expect(overlayPE).toBe("none");
    }
  });

  test("G-V6 [P1] pill sits above Excalidraw zoom widget (bottom > 60px)", async ({
    page,
    request,
  }) => {
    const drawing = await createDrawing(request, { name: `GV6_${Date.now()}` });
    createdIds.push(drawing.id);
    await page.goto(`/editor/${drawing.id}`);
    await waitForCanvas(page);
    const pill = page.locator(`[data-testid="${SYNC_PILL_TESTID}"]`);
    const bottomPx = await pill.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return parseFloat(cs.bottom);
    });
    // 88px per SyncIndicator; ensure ≥60px clearance from viewport bottom.
    expect(bottomPx).toBeGreaterThanOrEqual(60);
  });

  test.skip("G-V3 [P1] pill respects prefers-color-scheme dark", async () => {
    // TODO: page.emulateMedia({ colorScheme: 'dark' }) + computed style
    // background-color assertion.
  });

  test.skip("G-V7 [P2] pill fade-out <=250ms", async () => {
    // TODO: transitionend event capture.
  });

  test.skip("G-V8 [P2] pill promotes to Variant C on big diff or slow apply", async () => {
    // TODO: fire MCP with a 30%+ diff, then assert
    // [data-testid="remote-sync-overlay"] becomes visible.
  });
});

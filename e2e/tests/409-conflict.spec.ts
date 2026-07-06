import { test, expect } from "@playwright/test";
import {
  createDrawing,
  deleteDrawing,
  getDrawing,
  updateDrawing,
  API_URL,
} from "./helpers/api";

/**
 * E2E for the two-layer versioning fix.
 *
 * Layer 1: Drawing-level 409 auto-merge
 *   Server returns 409 VERSION_CONFLICT when a PUT includes a stale `version`.
 *   The frontend's auto-merge path is unit-tested exhaustively in
 *   `frontend/src/pages/editor/persistenceConflict.test.ts`; here we verify
 *   the *server contract* the client depends on — namely that a stale-version
 *   PUT is rejected with 409 and the response body carries `currentVersion`.
 *
 * Layer 2: App-level build id header
 *   Every response includes an `X-App-Version` header the SPA compares
 *   against its boot value to prompt for reload.
 */

test.describe("Two-layer versioning", () => {
  let createdDrawingIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdDrawingIds) {
      try {
        await deleteDrawing(request, id);
      } catch {
        // ignore
      }
    }
    createdDrawingIds = [];
  });

  test("advertises X-App-Version header on every response", async ({
    request,
  }) => {
    const health = await request.get(`${API_URL}/health`);
    expect(health.ok()).toBeTruthy();
    const headerHealth = health.headers()["x-app-version"];
    expect(headerHealth, "X-App-Version must be set on /health").toBeTruthy();

    // Non-health path: still set.
    const drawings = await request.get(`${API_URL}/drawings`);
    // 401 is fine (unauthenticated); the header must still be present.
    const headerDrawings = drawings.headers()["x-app-version"];
    expect(headerDrawings, "X-App-Version must be set on /drawings").toBeTruthy();
    expect(headerDrawings).toBe(headerHealth);
  });

  test("rejects stale-version PUT with 409 VERSION_CONFLICT + currentVersion", async ({
    request,
  }) => {
    const drawing = await createDrawing(request, {
      name: `Version_Conflict_${Date.now()}`,
    });
    createdDrawingIds.push(drawing.id);

    // Simulate an out-of-band writer (like the MCP server) advancing the
    // drawing's version.
    await updateDrawing(request, drawing.id, {
      elements: [
        {
          id: "mcp-1",
          type: "rectangle",
          x: 10,
          y: 10,
          width: 100,
          height: 100,
          version: 1,
          versionNonce: 100,
        },
      ],
      appState: {},
    });
    const afterFirst = await getDrawing(request, drawing.id);
    expect(afterFirst.version).toBeGreaterThanOrEqual(2);

    // Now attempt a PUT with the original stale version. Server must 409.
    const headers = await (async () => {
      const csrfRes = await request.get(`${API_URL}/csrf-token`);
      const csrfBody = (await csrfRes.json()) as {
        token: string;
        header?: string;
      };
      const headerName =
        typeof csrfBody.header === "string" && csrfBody.header.length > 0
          ? csrfBody.header
          : "x-csrf-token";
      return {
        "Content-Type": "application/json",
        [headerName]: csrfBody.token,
      };
    })();
    const stalePut = await request.put(`${API_URL}/drawings/${drawing.id}`, {
      headers,
      data: {
        elements: [
          {
            id: "browser-1",
            type: "rectangle",
            x: 200,
            y: 200,
            width: 50,
            height: 50,
            version: 1,
            versionNonce: 200,
          },
        ],
        appState: {},
        version: 1,
      },
    });

    expect(stalePut.status()).toBe(409);
    const body = (await stalePut.json()) as {
      code?: string;
      currentVersion?: number;
    };
    expect(body.code).toBe("VERSION_CONFLICT");
    expect(typeof body.currentVersion).toBe("number");
    expect(body.currentVersion).toBeGreaterThanOrEqual(2);

    // MCP's write is still on the server — no wipe.
    const final = await getDrawing(request, drawing.id);
    const finalIds = (final.elements as any[]).map((e: any) => e.id);
    expect(finalIds).toContain("mcp-1");
  });
});

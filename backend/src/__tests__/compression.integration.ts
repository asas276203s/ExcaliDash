/**
 * Integration test for HTTP response compression.
 *
 * The dashboard list endpoint (`GET /drawings?includePreview=true`) returns a
 * per-drawing SVG preview and runs ~1.5MB uncompressed for a full page. This
 * test verifies the `compression` middleware gzips that response when the client
 * accepts gzip (and leaves it uncompressed otherwise), and logs the real
 * before/after byte numbers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import zlib from "zlib";
import bcrypt from "bcrypt";
import { PrismaClient } from "../generated/client";
import { generateApiKey, serializeApiKeyScopes } from "../auth/apiKeys";
import { getTestPrisma, setupTestDb } from "./testUtils";

describe("Response compression", () => {
  let prisma: PrismaClient;
  let app: any;
  let token: string;

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    ({ app } = await import("../index"));

    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: { authEnabled: true, registrationEnabled: false },
      create: { id: "default", authEnabled: true, registrationEnabled: false },
    });

    const passwordHash = await bcrypt.hash("password123", 10);
    const user = await prisma.user.create({
      data: {
        email: "compression-user@test.local",
        passwordHash,
        name: "Compression User",
        role: "USER",
        isActive: true,
      },
      select: { id: true },
    });

    const generated = generateApiKey();
    await prisma.apiKey.create({
      data: {
        userId: user.id,
        name: "compression-test",
        keyId: generated.keyId,
        tokenHash: generated.tokenHash,
        prefix: generated.prefix,
        scopes: serializeApiKeyScopes(),
      },
    });
    token = generated.token;

    // Realistic ~hundreds-of-path SVG preview per drawing so the list payload
    // comfortably exceeds compression's 1KB threshold.
    const preview =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">' +
      Array.from({ length: 400 })
        .map(
          (_, i) =>
            `<path d="M${i} ${i} L${i + 10} ${i + 20}" stroke="#000000" fill="none" stroke-width="2"></path>`,
        )
        .join("") +
      "</svg>";
    for (let i = 0; i < 6; i += 1) {
      await prisma.drawing.create({
        data: {
          name: `Compression Drawing ${i}`,
          elements: "[]",
          appState: "{}",
          files: "{}",
          preview,
          userId: user.id,
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("gzips GET /drawings when the client accepts gzip", async () => {
    const res = await request(app)
      .get("/drawings?includePreview=true")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept-Encoding", "gzip");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
  });

  it("leaves the response uncompressed when the client does not accept encoding", async () => {
    const res = await request(app)
      .get("/drawings?includePreview=true")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept-Encoding", "identity");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();

    // Real before/after numbers for the perf report.
    const uncompressed = Buffer.byteLength(res.text);
    const compressed = zlib.gzipSync(Buffer.from(res.text)).length;
    console.log(
      `[compression] /drawings payload: uncompressed=${uncompressed}B gzip=${compressed}B ratio=${(
        uncompressed / compressed
      ).toFixed(1)}x`,
    );
    // SVG/JSON text should compress dramatically.
    expect(compressed).toBeLessThan(uncompressed / 3);
  });
});

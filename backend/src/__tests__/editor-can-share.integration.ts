import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import { StringValue } from "ms";
import { PrismaClient } from "../generated/client";
import { config } from "../config";
import { getTestPrisma, setupTestDb } from "./testUtils";

// Sharing used to be owner-only. Editors can now manage it too, but the
// owner's own access stays off limits to them.
describe("Sharing - editor access", () => {
  const userAgent = "vitest-editor-can-share";
  let prisma: PrismaClient;
  let app: any;
  let ownerId = "";
  let editorId = "";
  let viewerId = "";
  let drawingId = "";
  let editorToken = "";
  let viewerToken = "";
  let ownerPermId = "";

  const tokenFor = (userId: string, email: string) => {
    const signOptions: SignOptions = {
      expiresIn: config.jwtAccessExpiresIn as StringValue,
    };
    return jwt.sign(
      { userId, email, type: "access" },
      config.jwtSecret,
      signOptions,
    );
  };

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    ({ app } = await import("../index"));

    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: { authEnabled: true, registrationEnabled: false },
      create: {
        id: "default",
        authEnabled: true,
        registrationEnabled: false,
      },
    });

    const passwordHash = await bcrypt.hash("pw-for-tests-1234", 4);
    const mk = async (email: string, name: string) =>
      prisma.user.create({
        data: { email, passwordHash, name, role: "USER", isActive: true },
        select: { id: true, email: true },
      });

    const owner = await mk("share-owner@test.local", "Owner");
    const editor = await mk("share-editor@test.local", "Editor");
    const viewer = await mk("share-viewer@test.local", "Viewer");
    ownerId = owner.id;
    editorId = editor.id;
    viewerId = viewer.id;

    const drawing = await prisma.drawing.create({
      data: {
        name: "Shared drawing",
        elements: "[]",
        appState: "{}",
        files: "{}",
        userId: ownerId,
        collectionId: null,
        version: 1,
      },
      select: { id: true },
    });
    drawingId = drawing.id;

    const ownerPerm = await prisma.drawingPermission.create({
      data: {
        drawingId,
        granteeUserId: ownerId,
        permission: "edit",
        createdByUserId: ownerId,
      },
      select: { id: true },
    });
    ownerPermId = ownerPerm.id;

    await prisma.drawingPermission.create({
      data: {
        drawingId,
        granteeUserId: editorId,
        permission: "edit",
        createdByUserId: ownerId,
      },
    });
    await prisma.drawingPermission.create({
      data: {
        drawingId,
        granteeUserId: viewerId,
        permission: "view",
        createdByUserId: ownerId,
      },
    });

    editorToken = tokenFor(editorId, editor.email);
    viewerToken = tokenFor(viewerId, viewer.email);
  });

  it("lets an editor read the sharing settings", async () => {
    const res = await request(app)
      .get(`/drawings/${drawingId}/sharing`)
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${editorToken}`);
    expect(res.status).toBe(200);
  });

  it("still hides sharing from a view-only collaborator", async () => {
    const res = await request(app)
      .get(`/drawings/${drawingId}/sharing`)
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(404);
  });

  it("refuses to let an editor remove the owner's access", async () => {
    const res = await request(app)
      .delete(`/drawings/${drawingId}/permissions/${ownerPermId}`)
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${editorToken}`);
    expect(res.status).toBe(403);

    const stillThere = await prisma.drawingPermission.findFirst({
      where: { id: ownerPermId },
    });
    expect(stillThere).not.toBeNull();
  });

  it("refuses to let an editor rewrite the owner's permission", async () => {
    const res = await request(app)
      .post(`/drawings/${drawingId}/permissions`)
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ granteeUserId: ownerId, permission: "view" });
    expect(res.status).toBe(403);
  });
});

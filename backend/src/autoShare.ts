// Auto-share helper: every drawing + collection is automatically shared
// with every other active user in the workspace, so the "workspace" acts
// like a shared team space by default.
//
// Grantee list resolution:
//   - Mode "all" (default): SELECT id FROM User WHERE isActive at share
//     time — no env var needed. Newly added users automatically get access
//     to everything moving forward, and existing users don't need any
//     config change when a teammate joins.
//   - Mode "env": legacy behaviour — read AUTO_SHARE_USER_IDS env var
//     (comma-separated ids). Kept for edge cases where a workspace needs
//     an explicit allowlist.
//   - Mode "off": no auto-share.
//
// Both helpers are best-effort: any per-grantee failure is logged and
// swallowed so a bad configuration cannot break the user-facing create
// flow. When the DB query itself fails we swallow and skip auto-share
// for that call — the drawing/collection still gets created.

import type { PrismaClient } from "./generated/client";

type AutoShareMode = "all" | "env" | "off";

const resolveMode = (): AutoShareMode => {
  const raw = (process.env.AUTO_SHARE_MODE || "all").trim().toLowerCase();
  if (raw === "off") return "off";
  if (raw === "env") return "env";
  return "all";
};

let cachedEnvGrantees: string[] | null = null;

const resolveEnvGrantees = (): string[] => {
  if (cachedEnvGrantees !== null) return cachedEnvGrantees;
  const raw = (process.env.AUTO_SHARE_USER_IDS || "").trim();
  cachedEnvGrantees = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  return cachedEnvGrantees;
};

/** Test-only: forget the memoized env value so a new AUTO_SHARE_USER_IDS is picked up. */
export const __resetAutoShareCache = (): void => {
  cachedEnvGrantees = null;
};

const logAutoShareError = (context: string, err: unknown): void => {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`[auto-share] ${context}: ${message}`);
};

const resolveAllUsers = async (
  prisma: PrismaClient,
  ownerUserId: string,
): Promise<string[]> => {
  try {
    const users = await prisma.user.findMany({
      where: {
        isActive: true,
        NOT: { id: ownerUserId },
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  } catch (err) {
    logAutoShareError("resolveAllUsers", err);
    return [];
  }
};

const resolveGrantees = async (
  prisma: PrismaClient,
  ownerUserId: string,
): Promise<string[]> => {
  const mode = resolveMode();
  if (mode === "off") return [];
  if (mode === "env")
    return resolveEnvGrantees().filter((id) => id !== ownerUserId);
  return resolveAllUsers(prisma, ownerUserId);
};

/** Exposed for tests + backfill scripts. */
export const getAutoShareGrantees = async (
  prisma: PrismaClient,
  ownerUserId: string,
): Promise<string[]> => resolveGrantees(prisma, ownerUserId);

export const autoShareDrawing = async (
  prisma: PrismaClient,
  drawingId: string,
  ownerUserId: string,
): Promise<void> => {
  const grantees = await resolveGrantees(prisma, ownerUserId);
  if (grantees.length === 0) return;

  for (const granteeUserId of grantees) {
    if (!granteeUserId || granteeUserId === ownerUserId) continue;
    try {
      await prisma.drawingPermission.upsert({
        where: {
          drawingId_granteeUserId: { drawingId, granteeUserId },
        },
        update: {
          permission: "edit",
          createdByUserId: ownerUserId,
        },
        create: {
          drawingId,
          granteeUserId,
          permission: "edit",
          createdByUserId: ownerUserId,
        },
      });
    } catch (err) {
      logAutoShareError(
        `drawing upsert failed drawing=${drawingId} grantee=${granteeUserId}`,
        err,
      );
    }
  }
};

export const autoShareCollection = async (
  prisma: PrismaClient,
  collectionId: string,
  ownerUserId: string,
): Promise<void> => {
  const grantees = await resolveGrantees(prisma, ownerUserId);
  if (grantees.length === 0) return;

  for (const granteeUserId of grantees) {
    if (!granteeUserId || granteeUserId === ownerUserId) continue;
    try {
      await prisma.collectionShare.upsert({
        where: {
          collectionId_granteeUserId: {
            collectionId,
            granteeUserId,
          },
        },
        update: {
          role: "edit",
          createdByUserId: ownerUserId,
        },
        create: {
          collectionId,
          granteeUserId,
          role: "edit",
          createdByUserId: ownerUserId,
        },
      });
    } catch (err) {
      logAutoShareError(
        `collection upsert failed collection=${collectionId} grantee=${granteeUserId}`,
        err,
      );
    }
  }
};

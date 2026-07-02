// Auto-share helper: mirrors bamolab-overlay auto-share behavior natively in
// TypeScript, so the fork can be built and deployed as a first-class image
// (no runtime JS patching required).
//
// Reads AUTO_SHARE_USER_IDS (comma-separated user ids) once per process and
// exposes two upsert helpers:
//   - autoShareDrawing:   copies a newly created drawing to DrawingPermission
//                         (permission "edit") for every grantee.
//   - autoShareCollection: copies a newly created collection to CollectionShare
//                         (role "edit") for every grantee.
//
// Both helpers are best-effort: any per-grantee failure is logged and swallowed
// so a bad configuration cannot break the user-facing create flow.

import type { PrismaClient } from "./generated/client";

let cachedGrantees: string[] | null = null;

const resolveGrantees = (): string[] => {
  if (cachedGrantees !== null) return cachedGrantees;
  const raw = (process.env.AUTO_SHARE_USER_IDS || "").trim();
  cachedGrantees = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  return cachedGrantees;
};

/** Test-only: forget the memoized env value so a new AUTO_SHARE_USER_IDS is picked up. */
export const __resetAutoShareCache = (): void => {
  cachedGrantees = null;
};

export const getAutoShareGrantees = (): string[] => resolveGrantees();

const logAutoShareError = (context: string, err: unknown): void => {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`[auto-share] ${context}: ${message}`);
};

export const autoShareDrawing = async (
  prisma: PrismaClient,
  drawingId: string,
  ownerUserId: string,
): Promise<void> => {
  const grantees = resolveGrantees();
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
  const grantees = resolveGrantees();
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

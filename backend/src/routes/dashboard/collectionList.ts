import type { PrismaClient } from "../../generated/client";
import {
  isTeamSharedMode,
  teamSharedCollectionListWhere,
} from "../../teamSharedMode";

/**
 * Builds the GET /collections payload: collections the caller can see, each
 * annotated with `isOwner` / `sharedRole` / `isShared`.
 *
 * TEAM_SHARED_MODE (fork customization, not upstream): when enabled, this lists
 * every collection in the instance instead of only the caller's, so a teammate
 * who joined later still sees everything. Other users' trash buckets
 * (`trash:<userId>`) stay hidden — trash remains per-user. Ownership is still
 * reported honestly, because rename/delete/share stay owner-only server-side.
 */
export const listCollectionsForUser = async (
  prisma: PrismaClient,
  userId: string,
  trashCollectionId: string,
): Promise<unknown[]> => {
  const rawCollections = await prisma.collection.findMany({
    where: isTeamSharedMode()
      ? teamSharedCollectionListWhere(userId)
      : { userId },
    orderBy: { createdAt: "desc" },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  const hasInternalTrash = rawCollections.some(
    (c) => c.id === trashCollectionId,
  );
  const shareCountMap = await prisma.collectionShare.groupBy({
    by: ["collectionId"],
    where: { collectionId: { in: rawCollections.map((c) => c.id) } },
    _count: { collectionId: true },
  });
  const sharedCollectionIds = new Set(shareCountMap.map((s) => s.collectionId));

  const ownedCollections = rawCollections
    .filter((c) => !(hasInternalTrash && c.id === "trash"))
    .map((c) =>
      c.id === trashCollectionId
        ? {
            ...c,
            id: "trash",
            name: "Trash",
            sharedRole: null,
            isOwner: true,
            isShared: false,
          }
        : {
            ...c,
            sharedRole: c.userId === userId ? null : "edit",
            isOwner: c.userId === userId,
            isShared: sharedCollectionIds.has(c.id),
          },
    );

  // Collections shared with this user by others.
  const sharedEntries = await prisma.collectionShare.findMany({
    where: { granteeUserId: userId },
    include: {
      collection: {
        include: { user: { select: { id: true, name: true, email: true } } },
      },
    },
  });
  // TEAM_SHARED_MODE: dedupe — the query above may already have returned these.
  const alreadyListed = new Set(ownedCollections.map((c) => c.id));
  const sharedCollections = sharedEntries
    .filter((s) => !alreadyListed.has(s.collectionId))
    .map((s) => ({ ...s.collection, sharedRole: s.role, isOwner: false }));

  return [...ownedCollections, ...sharedCollections];
};

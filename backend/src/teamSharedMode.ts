// ─── TEAM_SHARED_MODE (self-hosted fork customization) ──────────────────────
//
// NOT UPSTREAM. This module exists only in the self-hosted bamolab fork.
// When syncing with ZimengXiong/ExcaliDash, every call site is marked with a
// `TEAM_SHARED_MODE` comment so the customization is easy to spot / re-apply.
//
// Upstream ExcaliDash is strictly owner + per-row ACL: a Drawing/Collection is
// visible to its `userId` owner plus whoever has an explicit DrawingPermission
// / CollectionShare row. For a small self-hosted team instance that is the
// wrong default — every teammate (including people who join later) should see
// every canvas and every collection, including ones created before they had an
// account. Row-based auto-share (see `autoShare.ts`) cannot do that
// retroactively for pre-existing content.
//
// TEAM_SHARED_MODE=true flips authorization to "any authenticated user has
// full access to every drawing and every collection".
//
// Deliberately NOT changed by this flag:
//   - anonymous / signed-out paths (a visitor with no session still gets
//     nothing except what link-share policies grant)
//   - link-share (DrawingLinkShare) evaluation
//   - API-key middleware permissions
//   - owner-only *destructive* endpoints that check `drawing.userId` /
//     `collection.userId` directly: hard DELETE /drawings/:id, collection
//     rename/delete, and share management. Those stay with the creator so a
//     teammate cannot irreversibly destroy someone else's work; everything
//     reversible (view, edit, move between collections, move to trash) is open.
//
// Default is false → identical behavior to upstream.

import type { Prisma } from "./generated/client";

const parseBoolean = (raw: string | undefined): boolean => {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "on";
};

/**
 * True when the instance runs as a single shared team workspace.
 * Read lazily (not memoized) so tests can toggle process.env.
 */
export const isTeamSharedMode = (): boolean =>
  parseBoolean(process.env.TEAM_SHARED_MODE);

/**
 * Trash is still per-user even in team shared mode: internal trash collection
 * ids are `trash:<userId>` (plus the legacy bare "trash"). Team-wide listings
 * must not surface other people's trash.
 */
export const TRASH_COLLECTION_ID_PREFIX = "trash:";

/**
 * Drawing-list access clauses for team shared mode: every drawing in the
 * instance, minus other users' trash. `not: null` guards keep the negated LIKE
 * comparison from going three-valued on NULL collectionId rows.
 */
export const teamSharedDrawingAccessClauses = (
  userId: string,
  trashCollectionId: string,
): Prisma.DrawingWhereInput[] => [
  // Uncategorized drawings (anyone's).
  { collectionId: null },
  // My own trash (and the legacy bare "trash" bucket, if I own the row).
  { collectionId: trashCollectionId },
  { collectionId: "trash", userId },
  // Everything in a real (non-trash) collection, whoever owns it.
  {
    AND: [
      { collectionId: { not: null } },
      { collectionId: { not: "trash" } },
      { NOT: { collectionId: { startsWith: TRASH_COLLECTION_ID_PREFIX } } },
    ],
  },
];

/**
 * Collection-list filter for team shared mode: every collection in the
 * instance, minus other users' trash buckets.
 */
export const teamSharedCollectionListWhere = (
  userId: string,
): Prisma.CollectionWhereInput => ({
  OR: [
    { userId },
    {
      AND: [
        { NOT: { id: { startsWith: TRASH_COLLECTION_ID_PREFIX } } },
        { id: { not: "trash" } },
      ],
    },
  ],
});

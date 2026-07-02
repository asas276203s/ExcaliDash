#!/usr/bin/env node
"use strict";
// backfill-auto-share.js — walks every existing drawing AND collection and
// inserts a permission row for every user id in AUTO_SHARE_USER_IDS.
//
// Behavior:
//   Drawings   → DrawingPermission  (permission: "edit")
//   Collections → CollectionShare   (role: "edit")
//
// Usage (Zeabur):
//   executeCommand(command:["node","/app/backend/scripts/backfill-auto-share.js"])
//
// Usage (local docker):
//   docker exec <container> node /app/scripts/backfill-auto-share.js
//
// Flags:
//   --dry-run          Print what would happen without writing.
//   --skip-drawings    Only backfill collections.
//   --skip-collections Only backfill drawings.
//   --owner=<id>       Only backfill items owned by this user id.
//   --limit=<n>        Cap the number of items processed per kind (debugging).
//
// The script uses the same generated Prisma client the app uses, so it
// respects the runtime-selected DATABASE_PROVIDER set by docker-entrypoint.sh.

function parseArgs(argv) {
  const args = {
    dryRun: false,
    skipDrawings: false,
    skipCollections: false,
    owner: null,
    limit: null,
  };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--skip-drawings") args.skipDrawings = true;
    else if (a === "--skip-collections") args.skipCollections = true;
    else if (a.startsWith("--owner=")) args.owner = a.slice("--owner=".length);
    else if (a.startsWith("--limit=")) args.limit = Number(a.slice("--limit=".length));
    else if (a === "--help" || a === "-h") {
      // eslint-disable-next-line no-console
      console.log(
        "backfill-auto-share.js — auto-share every existing drawing + collection with AUTO_SHARE_USER_IDS\n\n" +
          "Flags:\n" +
          "  --dry-run          print planned changes only\n" +
          "  --skip-drawings    only process collections\n" +
          "  --skip-collections only process drawings\n" +
          "  --owner=<id>       restrict to items owned by this user\n" +
          "  --limit=<n>        process at most n items per kind\n",
      );
      process.exit(0);
    }
  }
  return args;
}

function resolveEnvGrantees() {
  const raw = (process.env.AUTO_SHARE_USER_IDS || "").trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function resolveMode() {
  const raw = (process.env.AUTO_SHARE_MODE || "all").trim().toLowerCase();
  if (raw === "off") return "off";
  if (raw === "env") return "env";
  return "all";
}

async function resolveAllUserIds(prisma) {
  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

async function resolveGrantees(prisma) {
  const mode = resolveMode();
  if (mode === "off") return [];
  if (mode === "env") return resolveEnvGrantees();
  return resolveAllUserIds(prisma);
}

async function loadPrisma() {
  // Same generated client as the app. Try multiple layouts:
  //   /app/dist/generated/client         — production Docker image (this fork)
  //   /app/src/generated/client          — Docker builder stage
  //   /app/backend/src/generated/client  — inside a full mono-repo checkout
  //   ../src/generated/client            — running from backend/scripts locally
  const path = require("path");
  const candidates = [
    "/app/dist/generated/client",
    "/app/src/generated/client",
    "/app/backend/src/generated/client",
    "/app/backend/dist/generated/client",
    path.resolve(__dirname, "../src/generated/client"),
    path.resolve(__dirname, "../dist/generated/client"),
  ];
  let lastErr = null;
  for (const p of candidates) {
    try {
      // eslint-disable-next-line global-require
      const mod = require(p);
      const PrismaClient = mod.PrismaClient;
      if (!PrismaClient) continue;
      return new PrismaClient();
    } catch (err) {
      lastErr = err;
    }
  }
  try {
    // eslint-disable-next-line global-require
    const { PrismaClient } = require("@prisma/client");
    return new PrismaClient();
  } catch (err) {
    lastErr = err;
  }
  const details = lastErr ? `: ${(lastErr && lastErr.message) || lastErr}` : "";
  throw new Error(`Could not load a Prisma client${details}`);
}

async function backfillDrawings(prisma, grantees, args) {
  const where = args.owner ? { userId: args.owner } : {};
  const take = args.limit && Number.isFinite(args.limit) ? args.limit : undefined;
  const drawings = await prisma.drawing.findMany({
    where,
    select: { id: true, userId: true, name: true },
    take,
  });
  // eslint-disable-next-line no-console
  console.log(`[backfill:drawings] scanning ${drawings.length} drawing(s)`);

  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  for (const d of drawings) {
    for (const granteeUserId of grantees) {
      if (granteeUserId === d.userId) {
        skipped += 1;
        continue;
      }
      if (args.dryRun) {
        // eslint-disable-next-line no-console
        console.log(
          `[backfill:drawings] would share drawing ${d.id} (${d.name}) with ${granteeUserId}`,
        );
        inserted += 1;
        continue;
      }
      try {
        await prisma.drawingPermission.upsert({
          where: {
            drawingId_granteeUserId: {
              drawingId: d.id,
              granteeUserId,
            },
          },
          update: { permission: "edit", createdByUserId: d.userId },
          create: {
            drawingId: d.id,
            granteeUserId,
            permission: "edit",
            createdByUserId: d.userId,
          },
        });
        inserted += 1;
      } catch (err) {
        failed += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[backfill:drawings] upsert failed drawing=${d.id} grantee=${granteeUserId}: ${
            (err && err.message) || err
          }`,
        );
      }
    }
  }
  return { inserted, skipped, failed, total: drawings.length };
}

async function backfillCollections(prisma, grantees, args) {
  const where = args.owner ? { userId: args.owner } : {};
  const take = args.limit && Number.isFinite(args.limit) ? args.limit : undefined;
  const collections = await prisma.collection.findMany({
    where,
    select: { id: true, userId: true, name: true },
    take,
  });
  // eslint-disable-next-line no-console
  console.log(`[backfill:collections] scanning ${collections.length} collection(s)`);

  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  for (const c of collections) {
    for (const granteeUserId of grantees) {
      if (granteeUserId === c.userId) {
        skipped += 1;
        continue;
      }
      if (args.dryRun) {
        // eslint-disable-next-line no-console
        console.log(
          `[backfill:collections] would share collection ${c.id} (${c.name}) with ${granteeUserId}`,
        );
        inserted += 1;
        continue;
      }
      try {
        await prisma.collectionShare.upsert({
          where: {
            collectionId_granteeUserId: {
              collectionId: c.id,
              granteeUserId,
            },
          },
          update: { role: "edit", createdByUserId: c.userId },
          create: {
            collectionId: c.id,
            granteeUserId,
            role: "edit",
            createdByUserId: c.userId,
          },
        });
        inserted += 1;
      } catch (err) {
        failed += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[backfill:collections] upsert failed collection=${c.id} grantee=${granteeUserId}: ${
            (err && err.message) || err
          }`,
        );
      }
    }
  }
  return { inserted, skipped, failed, total: collections.length };
}

async function main() {
  const args = parseArgs(process.argv);
  const prisma = await loadPrisma();
  const grantees = await resolveGrantees(prisma);
  const mode = resolveMode();
  if (grantees.length === 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[backfill] no grantees to backfill (mode=${mode}). Nothing to do.`,
    );
    process.exit(2);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[backfill] mode=${mode}  grantees=${grantees.join(", ")}${args.dryRun ? "  (DRY RUN)" : ""}`,
  );
  try {
    let drawingStats = null;
    let collectionStats = null;
    if (!args.skipDrawings) {
      drawingStats = await backfillDrawings(prisma, grantees, args);
    }
    if (!args.skipCollections) {
      collectionStats = await backfillCollections(prisma, grantees, args);
    }

    if (drawingStats) {
      // eslint-disable-next-line no-console
      console.log(
        `[backfill] drawings done: total=${drawingStats.total} upserts=${drawingStats.inserted} self-skipped=${drawingStats.skipped} failed=${drawingStats.failed}`,
      );
    }
    if (collectionStats) {
      // eslint-disable-next-line no-console
      console.log(
        `[backfill] collections done: total=${collectionStats.total} upserts=${collectionStats.inserted} self-skipped=${collectionStats.skipped} failed=${collectionStats.failed}`,
      );
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[backfill] fatal:", (err && err.stack) || err);
  process.exit(1);
});

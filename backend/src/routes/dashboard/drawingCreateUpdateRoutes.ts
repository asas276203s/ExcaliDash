import express from "express";
import { v4 as uuidv4 } from "uuid";
import { Prisma } from "../../generated/client";
import {
  canEditDrawing,
  getDrawingAccess,
  isOwnerAccess,
} from "../../authz/sharing";
import { autoShareDrawing } from "../../autoShare";
import { rewritePreviewForS3 } from "../../fileProcessing";
import {
  getSessionIdFromHeaders,
  recordServerLog,
} from "../../diagnostics/store";
import {
  getUserTrashCollectionId,
  isTrashCollectionId,
  toInternalTrashCollectionId,
  toPublicTrashCollectionId,
} from "./trash";
import type { DrawingRouteContext } from "./drawingRouteContext";

export const registerDrawingCreateUpdateRoutes = (
  app: express.Express,
  context: DrawingRouteContext,
) => {
  const {
    prisma,
    io,
    requireAuth,
    optionalAuth,
    asyncHandler,
    validateImportedDrawing,
    drawingCreateSchema,
    drawingUpdateSchema,
    respondWithValidationErrors,
    ensureTrashCollection,
    invalidateDrawingsCache,
    config,
    processFilesForS3,
    parseJsonField,
    getRequestPrincipal,
    respondWithAuthErrorIfPresent,
  } = context;

  // Tell any open editors joined to this drawing's collab room that the
  // server-side state has changed underneath them. The frontend listens
  // to "drawing-server-update" and reloads; without this event an MCP
  // update would silently sit on the server and the next user save would
  // overwrite it based on stale state.
  //
  // The payload carries the ORIGIN of the write (the saving session's
  // X-Session-Id and the acting user id) so each recipient can decide,
  // by exact match rather than a time-window heuristic, whether the echo
  // is their own save (skip), their own other window (apply silently), or
  // a genuine remote/MCP write (show the sync pill).
  const notifyServerStateChange = (
    drawingId: string,
    origin: { originSessionId: string | null; originUserId: string | null },
  ): void => {
    const roomId = `drawing_${drawingId}`;
    const roomSize = io.sockets.adapter.rooms.get(roomId)?.size ?? 0;
    io.to(roomId).emit("drawing-server-update", {
      drawingId,
      originSessionId: origin.originSessionId,
      originUserId: origin.originUserId,
    });
    // Room size is load-bearing for blank-canvas debugging: a broadcast that
    // fans out to 0 sockets (or the wrong room) means open editors never
    // learn about the write.
    void recordServerLog({
      type: "socket-broadcast",
      drawingId,
      message: "drawing-server-update",
      payload: {
        roomSize,
        originSessionId: origin.originSessionId,
        originUserId: origin.originUserId,
      },
    });
  };
  app.post(
    "/drawings",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const isImportedDrawing = req.headers["x-imported-file"] === "true";
      if (isImportedDrawing && !validateImportedDrawing(req.body)) {
        return res.status(400).json({
          error: "Invalid imported drawing file",
          message:
            "The imported file contains potentially malicious content or invalid structure",
        });
      }

      const parsed = drawingCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return respondWithValidationErrors(res, parsed.error.issues);
      }

      const payload = parsed.data as {
        name?: string;
        collectionId?: string | null;
        elements: unknown[];
        appState: Record<string, unknown>;
        preview?: string | null;
        files?: Record<string, unknown>;
      };
      const drawingName = payload.name ?? "Untitled Drawing";
      const targetCollectionIdRaw =
        payload.collectionId === undefined ? null : payload.collectionId;
      const targetCollectionId =
        toInternalTrashCollectionId(targetCollectionIdRaw, req.user.id) ?? null;

      if (
        targetCollectionId &&
        !isTrashCollectionId(targetCollectionId, req.user.id)
      ) {
        const collection = await prisma.collection.findFirst({
          where: { id: targetCollectionId },
        });
        if (!collection)
          return res.status(404).json({ error: "Collection not found" });

        // If the collection belongs to someone else, check the user has editor access
        if (collection.userId !== req.user.id) {
          const share = await prisma.collectionShare.findFirst({
            where: {
              collectionId: targetCollectionId,
              granteeUserId: req.user.id,
              role: "edit",
            },
          });
          if (!share)
            return res
              .status(403)
              .json({ error: "No edit access to this collection" });
        }
      } else if (targetCollectionIdRaw === "trash") {
        await ensureTrashCollection(prisma, req.user.id);
      }

      const newDrawingId = uuidv4();
      const originalFiles = payload.files ?? {};
      const processedFiles = await processFilesForS3(
        originalFiles,
        req.user.id,
        newDrawingId,
      );
      const processedPreview = rewritePreviewForS3(
        payload.preview ?? null,
        originalFiles,
        processedFiles,
      );

      const newDrawing = await prisma.drawing.create({
        data: {
          id: newDrawingId,
          name: drawingName,
          elements: JSON.stringify(payload.elements),
          appState: JSON.stringify(payload.appState),
          userId: req.user.id,
          collectionId: targetCollectionId,
          preview: typeof processedPreview === "string" ? processedPreview : null,
          files: JSON.stringify(processedFiles),
        },
      });
      // Auto-share this new drawing with users listed in AUTO_SHARE_USER_IDS.
      try {
        await autoShareDrawing(prisma, newDrawing.id, req.user.id);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[auto-share] drawing hook failed", err);
      }
      invalidateDrawingsCache();

      return res.json({
        ...newDrawing,
        collectionId: toPublicTrashCollectionId(
          newDrawing.collectionId,
          req.user.id,
        ),
        elements: parseJsonField(newDrawing.elements, []),
        appState: parseJsonField(newDrawing.appState, {}),
        files: parseJsonField(newDrawing.files, {}),
      });
    }),
  );

  app.put(
    "/drawings/:id",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const principal = await getRequestPrincipal(req);

      const { id } = req.params;
      const access = await getDrawingAccess({
        prisma,
        principal,
        drawingId: id,
      });
      if (!canEditDrawing(access)) {
        if (respondWithAuthErrorIfPresent(req, res)) return;
        return res.status(404).json({
          error: "Drawing not found",
          message: "Drawing does not exist",
        });
      }

      const existingDrawing = await prisma.drawing.findUnique({
        where: { id },
      });
      if (!existingDrawing)
        return res.status(404).json({ error: "Drawing not found" });

      const parsed = drawingUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        if (config.nodeEnv === "development") {
          console.error("[API] Validation failed", {
            id,
            errors: parsed.error.issues,
          });
        }
        return respondWithValidationErrors(res, parsed.error.issues);
      }

      const payload = parsed.data as {
        name?: string;
        collectionId?: string | null;
        elements?: unknown[];
        appState?: Record<string, unknown>;
        preview?: string | null;
        files?: Record<string, unknown>;
        version?: number;
      };
      const ownerUserId = existingDrawing.userId;
      const trashCollectionId = getUserTrashCollectionId(ownerUserId);
      const isSceneUpdate =
        payload.elements !== undefined ||
        payload.appState !== undefined ||
        payload.files !== undefined;

      const diagSessionId = getSessionIdFromHeaders(req.headers);
      const incomingElementCount = Array.isArray(payload.elements)
        ? payload.elements.length
        : null;

      if (isSceneUpdate && payload.version !== undefined && payload.version !== existingDrawing.version) {
        void recordServerLog({
          level: "warn",
          type: "drawing-save",
          sessionId: diagSessionId,
          drawingId: id,
          route: `PUT /drawings/${id}`,
          method: "PUT",
          status: 409,
          message: "version conflict (pre-check)",
          payload: {
            versionIn: payload.version,
            serverVersion: existingDrawing.version,
            elementsIn: incomingElementCount,
          },
        });
        return res.status(409).json({
          error: "Conflict",
          code: "VERSION_CONFLICT",
          message: "Drawing has changed since this editor state was loaded.",
          currentVersion: existingDrawing.version,
        });
      }
      const data: Prisma.DrawingUpdateInput = isSceneUpdate
        ? { version: { increment: 1 } }
        : {};

      if (payload.name !== undefined) data.name = payload.name;
      if (payload.elements !== undefined)
        data.elements = JSON.stringify(payload.elements);
      if (payload.appState !== undefined)
        data.appState = JSON.stringify(payload.appState);
      let processedFilesForUpdate: Record<string, unknown> | undefined;
      if (payload.files !== undefined) {
        processedFilesForUpdate = await processFilesForS3(
          payload.files,
          ownerUserId,
          id,
        );
        data.files = JSON.stringify(processedFilesForUpdate);
      }
      if (payload.preview !== undefined) {
        const processedPreview = processedFilesForUpdate
          ? rewritePreviewForS3(payload.preview, payload.files ?? {}, processedFilesForUpdate)
          : payload.preview;
        data.preview = typeof processedPreview === "string" ? processedPreview : null;
      }

      if (payload.collectionId !== undefined) {
        if (!isOwnerAccess(access)) {
          return res.status(403).json({
            error: "Forbidden",
            message: "Only the owner can move drawings between collections",
          });
        }
        if (payload.collectionId === "trash") {
          await ensureTrashCollection(prisma, ownerUserId);
          (data as Prisma.DrawingUncheckedUpdateInput).collectionId =
            trashCollectionId;
        } else if (payload.collectionId) {
          const collection = await prisma.collection.findFirst({
            where: { id: payload.collectionId, userId: ownerUserId },
          });
          if (!collection)
            return res.status(404).json({ error: "Collection not found" });
          (data as Prisma.DrawingUncheckedUpdateInput).collectionId =
            payload.collectionId;
        } else {
          (data as Prisma.DrawingUncheckedUpdateInput).collectionId = null;
        }
      }

      const updateWhere: Prisma.DrawingWhereInput = { id };
      if (isSceneUpdate && payload.version !== undefined) {
        updateWhere.version = payload.version;
      }

      const versionConflictError = new Error("VERSION_CONFLICT");
      let updatedDrawing: typeof existingDrawing | null = null;

      try {
        if (isSceneUpdate) {
          updatedDrawing = await prisma.$transaction(async (tx) => {
            await tx.drawingSnapshot.create({
              data: {
                drawingId: id,
                version: existingDrawing.version,
                elements: existingDrawing.elements,
                appState: existingDrawing.appState,
                files: existingDrawing.files,
              },
            });

            const updateResult = await tx.drawing.updateMany({
              where: updateWhere,
              data,
            });
            if (updateResult.count === 0) {
              throw versionConflictError;
            }

            return tx.drawing.findFirst({ where: { id } });
          });
        } else {
          const updateResult = await prisma.drawing.updateMany({
            where: updateWhere,
            data,
          });
          if (updateResult.count === 0) {
            return res.status(404).json({ error: "Drawing not found" });
          }
          updatedDrawing = await prisma.drawing.findFirst({
            where: { id },
          });
        }
      } catch (error) {
        if (
          error === versionConflictError ||
          (error instanceof Error &&
            error.message === versionConflictError.message)
        ) {
          const latestDrawing = await prisma.drawing.findFirst({
            where: { id },
            select: { version: true },
          });
          if (isSceneUpdate && payload.version !== undefined) {
            void recordServerLog({
              level: "warn",
              type: "drawing-save",
              sessionId: diagSessionId,
              drawingId: id,
              route: `PUT /drawings/${id}`,
              method: "PUT",
              status: 409,
              message: "version conflict (race on write)",
              payload: {
                versionIn: payload.version,
                serverVersion: latestDrawing?.version ?? null,
                elementsIn: incomingElementCount,
              },
            });
            return res.status(409).json({
              error: "Conflict",
              code: "VERSION_CONFLICT",
              message:
                "Drawing has changed since this editor state was loaded.",
              currentVersion: latestDrawing?.version ?? null,
            });
          }
        }
        throw error;
      }
      if (!updatedDrawing) {
        return res.status(404).json({ error: "Drawing not found" });
      }
      invalidateDrawingsCache();

      // Only scene-level updates (elements/appState/files) require open
      // editors to reload. Frontend fetch-and-merge (685c26a) refreshes
      // in place without a full page reload, so bursts of MCP updates
      // no longer spam the user.
      if (isSceneUpdate) {
        void recordServerLog({
          type: "drawing-save",
          sessionId: diagSessionId,
          drawingId: id,
          route: `PUT /drawings/${id}`,
          method: "PUT",
          status: 200,
          message: "scene saved",
          payload: {
            versionIn: payload.version ?? null,
            versionOut: updatedDrawing.version,
            elementsIn: incomingElementCount,
          },
        });
        notifyServerStateChange(id, {
          originSessionId: diagSessionId,
          originUserId: principal?.userId ?? null,
        });
      }

      return res.json({
        ...updatedDrawing,
        collectionId: toPublicTrashCollectionId(
          updatedDrawing.collectionId,
          ownerUserId,
        ),
        elements: parseJsonField(updatedDrawing.elements, []),
        appState: parseJsonField(updatedDrawing.appState, {}),
        files: parseJsonField(updatedDrawing.files, {}),
        accessLevel: access,
      });
    }),
  );

};

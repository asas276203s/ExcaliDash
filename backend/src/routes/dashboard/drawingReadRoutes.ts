import express from "express";
import { canViewDrawing, getDrawingAccess } from "../../authz/sharing";
import { normalizeDrawingElements } from "../../utils/normalizeElements";
import { toPublicTrashCollectionId } from "./trash";
import type { DrawingRouteContext } from "./drawingRouteContext";

export const registerDrawingReadRoutes = (
  app: express.Express,
  context: DrawingRouteContext,
) => {
  const {
    prisma,
    optionalAuth,
    asyncHandler,
    parseJsonField,
    getRequestPrincipal,
    respondWithAuthErrorIfPresent,
  } = context;
  app.get(
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
      if (!canViewDrawing(access)) {
        if (respondWithAuthErrorIfPresent(req, res)) return;
        return res.status(404).json({
          error: "Drawing not found",
          message: "Drawing does not exist",
        });
      }

      const drawing = await prisma.drawing.findUnique({ where: { id } });
      if (!drawing) {
        return res.status(404).json({
          error: "Drawing not found",
          message: "Drawing does not exist",
        });
      }

      const isOwner =
        principal?.kind === "user" && principal.userId === drawing.userId;
      return res.json({
        ...drawing,
        // Collections (and trash mapping) are owner-scoped. For shared/public access, avoid leaking
        // owner collection ids like `trash:<ownerId>` and avoid implying the viewer can organize it.
        collectionId: isOwner
          ? toPublicTrashCollectionId(drawing.collectionId, drawing.userId)
          : null,
        // Normalize on read so even drawings whose elements were persisted by
        // an MCP write (and are missing required fields like `groupIds`) come
        // back well-formed. This cleans existing dirty rows WITHOUT a data
        // migration — the client can never receive a crash-inducing element.
        elements: normalizeDrawingElements(parseJsonField(drawing.elements, [])),
        appState: parseJsonField(drawing.appState, {}),
        files: parseJsonField(drawing.files, {}),
        accessLevel: access,
        // The acting principal's id for THIS request. Mirrors the `originUserId`
        // stamped on drawing-server-update broadcasts, letting the editor decide
        // "this echo is my own other window" even when the client-side auth
        // context has no user (auth-disabled / bootstrap-admin mode).
        requestUserId: principal?.kind === "user" ? principal.userId : null,
      });
    }),
  );

};

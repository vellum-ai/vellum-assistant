/**
 * Route handler for surface action operations.
 *
 * POST /v1/surface-actions — dispatch a surface action to an active session.
 * Requires the session to already exist (does not create new sessions).
 */
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("surface-action-routes");

/** Any object that can handle a surface action. */
interface SurfaceActionTarget {
  handleSurfaceAction(
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ): void;
  handleSurfaceUndo?(surfaceId: string): void;
}

export type SessionLookup = (
  conversationId: string,
) => SurfaceActionTarget | undefined;

export type SessionLookupBySurfaceId = (
  surfaceId: string,
) => SurfaceActionTarget | undefined;

/**
 * POST /v1/surface-actions — handle a UI surface action.
 *
 * Body: { conversationId?, surfaceId, actionId, data? }
 */
export async function handleSurfaceAction(
  req: Request,
  findConversation: SessionLookup,
  findConversationBySurfaceId?: SessionLookupBySurfaceId,
): Promise<Response> {
  const body = (await req.json()) as {
    conversationId?: string | null;
    surfaceId?: string;
    actionId?: string;
    data?: Record<string, unknown>;
  };

  const { conversationId, surfaceId, actionId, data } = body;

  if (!surfaceId || typeof surfaceId !== "string") {
    return httpError("BAD_REQUEST", "surfaceId is required", 400);
  }
  if (!actionId || typeof actionId !== "string") {
    return httpError("BAD_REQUEST", "actionId is required", 400);
  }
  if (conversationId != null && typeof conversationId !== "string") {
    return httpError("BAD_REQUEST", "conversationId must be a string", 400);
  }

  const session = conversationId
    ? findConversation(conversationId)
    : findConversationBySurfaceId?.(surfaceId);

  if (!session) {
    return httpError("NOT_FOUND", "No active session found", 404);
  }

  try {
    session.handleSurfaceAction(surfaceId, actionId, data);
    log.info(
      { conversationId: conversationId ?? undefined, surfaceId, actionId },
      "Surface action handled via HTTP",
    );
    return Response.json({ ok: true });
  } catch (err) {
    log.error(
      { err, conversationId: conversationId ?? undefined, surfaceId, actionId },
      "Failed to handle surface action via HTTP",
    );
    return httpError("INTERNAL_ERROR", "Failed to handle surface action", 500);
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

/**
 * POST /v1/surfaces/:id/undo — undo the last surface action.
 *
 * Body: { conversationId }
 */
export async function handleSurfaceUndo(
  req: Request,
  surfaceId: string,
  findConversation: SessionLookup,
  findConversationBySurfaceId?: SessionLookupBySurfaceId,
): Promise<Response> {
  const body = (await req.json()) as {
    conversationId?: string | null;
  };

  const { conversationId } = body;

  if (conversationId != null && typeof conversationId !== "string") {
    return httpError("BAD_REQUEST", "conversationId must be a string", 400);
  }

  const session = conversationId
    ? findConversation(conversationId)
    : findConversationBySurfaceId?.(surfaceId);

  if (!session) {
    return httpError("NOT_FOUND", "No active session found", 404);
  }

  if (!session.handleSurfaceUndo) {
    return httpError(
      "NOT_IMPLEMENTED",
      "Surface undo not supported for this session type",
      501,
    );
  }

  try {
    session.handleSurfaceUndo(surfaceId);
    log.info({ conversationId, surfaceId }, "Surface undo handled via HTTP");
    return Response.json({ ok: true });
  } catch (err) {
    log.error(
      { err, conversationId, surfaceId },
      "Failed to handle surface undo via HTTP",
    );
    return httpError("INTERNAL_ERROR", "Failed to handle surface undo", 500);
  }
}

export function surfaceActionRouteDefinitions(deps: {
  findConversation?: SessionLookup;
  findConversationBySurfaceId?: SessionLookupBySurfaceId;
}): RouteDefinition[] {
  return [
    {
      endpoint: "surface-actions",
      method: "POST",
      handler: async ({ req }) => {
        if (!deps.findConversation) {
          return httpError(
            "NOT_IMPLEMENTED",
            "Surface actions not available",
            501,
          );
        }
        return handleSurfaceAction(
          req,
          deps.findConversation,
          deps.findConversationBySurfaceId,
        );
      },
    },
    {
      endpoint: "surfaces/:id/undo",
      method: "POST",
      handler: async ({ req, params }) => {
        if (!deps.findConversation) {
          return httpError(
            "NOT_IMPLEMENTED",
            "Surface undo not available",
            501,
          );
        }
        return handleSurfaceUndo(
          req,
          params.id,
          deps.findConversation,
          deps.findConversationBySurfaceId,
        );
      },
    },
  ];
}

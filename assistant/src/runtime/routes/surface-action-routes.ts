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

/** Any object that can handle a surface action (Session or ComputerUseSession). */
interface SurfaceActionTarget {
  handleSurfaceAction(
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ): void;
  handleSurfaceUndo?(surfaceId: string): void;
}

export type SessionLookup = (
  sessionId: string,
) => SurfaceActionTarget | undefined;

export type SessionLookupBySurfaceId = (
  surfaceId: string,
) => SurfaceActionTarget | undefined;

/**
 * POST /v1/surface-actions — handle a UI surface action.
 *
 * Body: { sessionId?, surfaceId, actionId, data? }
 */
export async function handleSurfaceAction(
  req: Request,
  findSession: SessionLookup,
  findSessionBySurfaceId?: SessionLookupBySurfaceId,
): Promise<Response> {
  const body = (await req.json()) as {
    sessionId?: string | null;
    surfaceId?: string;
    actionId?: string;
    data?: Record<string, unknown>;
  };

  const { sessionId, surfaceId, actionId, data } = body;

  if (!surfaceId || typeof surfaceId !== "string") {
    return httpError("BAD_REQUEST", "surfaceId is required", 400);
  }
  if (!actionId || typeof actionId !== "string") {
    return httpError("BAD_REQUEST", "actionId is required", 400);
  }
  if (sessionId != null && typeof sessionId !== "string") {
    return httpError("BAD_REQUEST", "sessionId must be a string", 400);
  }

  const session = sessionId
    ? findSession(sessionId)
    : findSessionBySurfaceId?.(surfaceId);

  if (!session) {
    return httpError("NOT_FOUND", "No active session found", 404);
  }

  try {
    session.handleSurfaceAction(surfaceId, actionId, data);
    log.info(
      { sessionId: sessionId ?? undefined, surfaceId, actionId },
      "Surface action handled via HTTP",
    );
    return Response.json({ ok: true });
  } catch (err) {
    log.error(
      { err, sessionId: sessionId ?? undefined, surfaceId, actionId },
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
 * Body: { sessionId }
 */
export async function handleSurfaceUndo(
  req: Request,
  surfaceId: string,
  findSession: SessionLookup,
  findSessionBySurfaceId?: SessionLookupBySurfaceId,
): Promise<Response> {
  const body = (await req.json()) as {
    sessionId?: string | null;
  };

  const { sessionId } = body;

  if (sessionId != null && typeof sessionId !== "string") {
    return httpError("BAD_REQUEST", "sessionId must be a string", 400);
  }

  const session = sessionId
    ? findSession(sessionId)
    : findSessionBySurfaceId?.(surfaceId);

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
    log.info({ sessionId, surfaceId }, "Surface undo handled via HTTP");
    return Response.json({ ok: true });
  } catch (err) {
    log.error(
      { err, sessionId, surfaceId },
      "Failed to handle surface undo via HTTP",
    );
    return httpError("INTERNAL_ERROR", "Failed to handle surface undo", 500);
  }
}

export function surfaceActionRouteDefinitions(deps: {
  findSession?: SessionLookup;
  findSessionBySurfaceId?: SessionLookupBySurfaceId;
}): RouteDefinition[] {
  return [
    {
      endpoint: "surface-actions",
      method: "POST",
      handler: async ({ req }) => {
        if (!deps.findSession) {
          return httpError(
            "NOT_IMPLEMENTED",
            "Surface actions not available",
            501,
          );
        }
        return handleSurfaceAction(
          req,
          deps.findSession,
          deps.findSessionBySurfaceId,
        );
      },
    },
    {
      endpoint: "surfaces/:id/undo",
      method: "POST",
      handler: async ({ req, params }) => {
        if (!deps.findSession) {
          return httpError(
            "NOT_IMPLEMENTED",
            "Surface undo not available",
            501,
          );
        }
        return handleSurfaceUndo(
          req,
          params.id,
          deps.findSession,
          deps.findSessionBySurfaceId,
        );
      },
    },
  ];
}

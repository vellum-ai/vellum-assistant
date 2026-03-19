/**
 * Route handler for surface action operations.
 *
 * POST /v1/surface-actions — dispatch a surface action to an active conversation.
 * Requires the conversation to already exist (does not create new conversations).
 */
import { getLogger } from "../../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import type { AuthContext } from "../auth/types.js";
import { healGuardianBindingDrift } from "../guardian-vellum-migration.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import {
  resolveTrustContext,
  withSourceChannel,
} from "../trust-context-resolver.js";

const log = getLogger("surface-action-routes");

/** Any object that can handle a surface action. */
interface SurfaceActionTarget {
  handleSurfaceAction(
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ): void;
  handleSurfaceUndo?(surfaceId: string): void;
  setTrustContext?(ctx: {
    trustClass: "guardian" | "trusted_contact" | "unknown";
    sourceChannel: string;
    [key: string]: unknown;
  }): void;
  trustContext?: { trustClass: string } | null;
}

export type ConversationLookup = (
  conversationId: string,
) => SurfaceActionTarget | undefined;

export type ConversationLookupBySurfaceId = (
  surfaceId: string,
) => SurfaceActionTarget | undefined;

/**
 * Resolve trust context from the request's auth context and set it on the
 * conversation, following the same pattern as POST /v1/messages. This ensures
 * surface actions inherit the correct trust class (guardian vs trusted_contact)
 * rather than defaulting to unknown.
 */
function applyTrustContext(
  conversation: SurfaceActionTarget,
  authContext: AuthContext,
): void {
  if (!conversation.setTrustContext) return;

  const sourceChannel = "vellum";

  if (authContext.actorPrincipalId) {
    const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
    let trustCtx = resolveTrustContext({
      assistantId,
      sourceChannel,
      conversationExternalId: "local",
      actorExternalId: authContext.actorPrincipalId,
    });
    if (trustCtx.trustClass === "unknown") {
      const healed = healGuardianBindingDrift(authContext.actorPrincipalId);
      if (healed) {
        trustCtx = resolveTrustContext({
          assistantId,
          sourceChannel,
          conversationExternalId: "local",
          actorExternalId: authContext.actorPrincipalId,
        });
        log.info(
          {
            actorPrincipalId: authContext.actorPrincipalId,
            trustClass: trustCtx.trustClass,
          },
          "Trust re-resolved after guardian binding drift heal (surface action)",
        );
      }
    }
    conversation.setTrustContext(withSourceChannel(sourceChannel, trustCtx));
  } else {
    // Service principals or tokens without an actor ID get guardian context.
    conversation.setTrustContext({ trustClass: "guardian", sourceChannel });
  }
}

/**
 * POST /v1/surface-actions — handle a UI surface action.
 *
 * Body: { conversationId?, surfaceId, actionId, data? }
 */
export async function handleSurfaceAction(
  req: Request,
  findConversation: ConversationLookup,
  findConversationBySurfaceId?: ConversationLookupBySurfaceId,
  authContext?: AuthContext,
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

  const conversation = conversationId
    ? findConversation(conversationId)
    : findConversationBySurfaceId?.(surfaceId);

  if (!conversation) {
    return httpError("NOT_FOUND", "No active conversation found", 404);
  }

  // Resolve trust context from the request's auth headers so the conversation
  // has the correct trust class for tool approval decisions.
  if (authContext) {
    applyTrustContext(conversation, authContext);
  }

  try {
    conversation.handleSurfaceAction(surfaceId, actionId, data);
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
  findConversation: ConversationLookup,
  findConversationBySurfaceId?: ConversationLookupBySurfaceId,
): Promise<Response> {
  const body = (await req.json()) as {
    conversationId?: string | null;
  };

  const { conversationId } = body;

  if (conversationId != null && typeof conversationId !== "string") {
    return httpError("BAD_REQUEST", "conversationId must be a string", 400);
  }

  const conversation = conversationId
    ? findConversation(conversationId)
    : findConversationBySurfaceId?.(surfaceId);

  if (!conversation) {
    return httpError("NOT_FOUND", "No active conversation found", 404);
  }

  if (!conversation.handleSurfaceUndo) {
    return httpError(
      "NOT_IMPLEMENTED",
      "Surface undo not supported for this conversation type",
      501,
    );
  }

  try {
    conversation.handleSurfaceUndo(surfaceId);
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
  findConversation?: ConversationLookup;
  findConversationBySurfaceId?: ConversationLookupBySurfaceId;
}): RouteDefinition[] {
  return [
    {
      endpoint: "surface-actions",
      method: "POST",
      handler: async ({ req, authContext }) => {
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
          authContext,
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

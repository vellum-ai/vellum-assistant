/**
 * Route handler for surface action operations.
 *
 * POST /v1/surface-actions — dispatch a surface action to an active conversation.
 * Requires the conversation to already exist (does not create new conversations).
 */
import { z } from "zod";

import type { ChannelId } from "../../channels/types.js";
import { isHttpAuthDisabled } from "../../config/env.js";
import {
  findConversation,
  findConversationBySurfaceId,
} from "../../daemon/conversation-store.js";
import { getLogger } from "../../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import type { AuthContext } from "../auth/types.js";
import { healGuardianBindingDrift } from "../guardian-vellum-migration.js";
import { httpError } from "../http-errors.js";
import type { HTTPRouteDefinition } from "../http-router.js";
import { resolveLocalTrustContext } from "../local-actor-identity.js";
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
  ): void | Promise<unknown>;
  handleSurfaceUndo?(surfaceId: string): void;
  setTrustContext?(ctx: {
    trustClass: "guardian" | "trusted_contact" | "unknown";
    sourceChannel: ChannelId;
  }): void;
  trustContext?: { trustClass: string } | null;
}

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
    // Dev bypass (HTTP auth disabled): the synthetic "dev-bypass" principal
    // won't match any guardian binding. Resolve from the local guardian
    // binding instead, which produces the correct guardian trust context.
    if (isHttpAuthDisabled() && authContext.actorPrincipalId === "dev-bypass") {
      conversation.setTrustContext(resolveLocalTrustContext(sourceChannel));
    } else {
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
    }
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
async function handleSurfaceAction(
  req: Request,
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
    // Most action paths return `void` (regular button/selection forwards);
    // the `launch_conversation` dispatch branch returns a structured result
    // so we can surface validation errors (e.g. missing title / seedPrompt)
    // as 4xx responses instead of silently reporting success.
    const raw = await conversation.handleSurfaceAction(
      surfaceId,
      actionId,
      data,
    );
    const result =
      raw && typeof raw === "object" && "accepted" in raw
        ? (raw as
            | { accepted: true; conversationId?: string }
            | { accepted: false; error: string })
        : undefined;
    if (result && result.accepted === false) {
      log.warn(
        {
          conversationId: conversationId ?? undefined,
          surfaceId,
          actionId,
          error: result.error,
        },
        "Surface action rejected",
      );
      return httpError("BAD_REQUEST", result.error, 400);
    }
    log.info(
      { conversationId: conversationId ?? undefined, surfaceId, actionId },
      "Surface action handled via HTTP",
    );
    if (
      result &&
      result.accepted === true &&
      typeof result.conversationId === "string"
    ) {
      return Response.json({ ok: true, conversationId: result.conversationId });
    }
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
async function handleSurfaceUndo(
  req: Request,
  surfaceId: string,
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

export function surfaceActionRouteDefinitions(): HTTPRouteDefinition[] {
  return [
    {
      endpoint: "surface-actions",
      method: "POST",
      summary: "Trigger a surface action",
      description:
        "Execute an interactive action on a surface (e.g. button click, form submit).",
      tags: ["surfaces"],
      requestBody: z.object({
        conversationId: z
          .string()
          .describe("Conversation that owns the surface")
          .optional(),
        surfaceId: z.string().describe("Surface to act on"),
        actionId: z.string().describe("Action identifier"),
        data: z
          .object({})
          .passthrough()
          .describe("Action-specific payload")
          .optional(),
      }),
      responseBody: z.object({
        ok: z.boolean(),
        conversationId: z
          .string()
          .describe(
            "Id of a newly launched conversation when the action dispatched one (e.g. launch_conversation). Omitted otherwise.",
          )
          .optional(),
      }),
      handler: async ({ req, authContext }) => {
        return handleSurfaceAction(req, authContext);
      },
    },
    {
      endpoint: "surfaces/:id/undo",
      method: "POST",
      summary: "Undo last surface action",
      description: "Revert the most recent action on a surface.",
      tags: ["surfaces"],
      requestBody: z.object({
        conversationId: z
          .string()
          .describe("Conversation that owns the surface"),
      }),
      responseBody: z.object({
        ok: z.boolean(),
      }),
      handler: async ({ req, params }) => {
        return handleSurfaceUndo(req, params.id);
      },
    },
  ];
}

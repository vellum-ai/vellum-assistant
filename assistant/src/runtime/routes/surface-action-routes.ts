/**
 * Route handler for surface action operations.
 *
 * POST /v1/surface-actions — dispatch a surface action to an active conversation.
 * Requires the conversation to already exist (does not create new conversations).
 *
 * Trust context is resolved from the `x-vellum-actor-principal-id` header
 * injected by the HTTP adapter from the authenticated AuthContext.
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
import { healGuardianBindingDrift } from "../guardian-vellum-migration.js";
import { resolveLocalTrustContext } from "../local-actor-identity.js";
import {
  resolveTrustContext,
  withSourceChannel,
} from "../trust-context-resolver.js";
import { BadRequestError, InternalError, NotFoundError, RouteError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("surface-action-routes");

// ---------------------------------------------------------------------------
// Trust resolution
// ---------------------------------------------------------------------------

/**
 * Resolve trust context from the actor principal ID and set it on the
 * conversation, following the same pattern as POST /v1/messages. This ensures
 * surface actions inherit the correct trust class (guardian vs trusted_contact)
 * rather than defaulting to unknown.
 */
function applyTrustContext(
  conversation: {
    setTrustContext?(ctx: {
      trustClass: "guardian" | "trusted_contact" | "unknown";
      sourceChannel: ChannelId;
    }): void;
  },
  actorPrincipalId: string | undefined,
): void {
  if (!conversation.setTrustContext) return;

  const sourceChannel = "vellum";

  if (actorPrincipalId) {
    if (isHttpAuthDisabled() && actorPrincipalId === "dev-bypass") {
      conversation.setTrustContext(resolveLocalTrustContext(sourceChannel));
    } else {
      const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
      let trustCtx = resolveTrustContext({
        assistantId,
        sourceChannel,
        conversationExternalId: "local",
        actorExternalId: actorPrincipalId,
      });
      if (trustCtx.trustClass === "unknown") {
        const healed = healGuardianBindingDrift(actorPrincipalId);
        if (healed) {
          trustCtx = resolveTrustContext({
            assistantId,
            sourceChannel,
            conversationExternalId: "local",
            actorExternalId: actorPrincipalId,
          });
          log.info(
            {
              actorPrincipalId,
              trustClass: trustCtx.trustClass,
            },
            "Trust re-resolved after guardian binding drift heal (surface action)",
          );
        }
      }
      conversation.setTrustContext(withSourceChannel(sourceChannel, trustCtx));
    }
  } else {
    conversation.setTrustContext({ trustClass: "guardian", sourceChannel });
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleSurfaceAction({
  body,
  headers,
}: RouteHandlerArgs): Promise<{
  ok: boolean;
  conversationId?: string;
}> {
  const conversationId = body?.conversationId as string | null | undefined;
  const surfaceId = body?.surfaceId as string | undefined;
  const actionId = body?.actionId as string | undefined;
  const data = body?.data as Record<string, unknown> | undefined;

  if (!surfaceId || typeof surfaceId !== "string") {
    throw new BadRequestError("surfaceId is required");
  }
  if (!actionId || typeof actionId !== "string") {
    throw new BadRequestError("actionId is required");
  }
  if (conversationId != null && typeof conversationId !== "string") {
    throw new BadRequestError("conversationId must be a string");
  }

  const conversation = conversationId
    ? findConversation(conversationId)
    : findConversationBySurfaceId(surfaceId);

  if (!conversation) {
    throw new NotFoundError("No active conversation found");
  }

  const actorPrincipalId = headers?.["x-vellum-actor-principal-id"];
  applyTrustContext(conversation, actorPrincipalId);

  try {
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
      throw new BadRequestError(result.error);
    }
    log.info(
      { conversationId: conversationId ?? undefined, surfaceId, actionId },
      "Surface action handled",
    );
    if (
      result &&
      result.accepted === true &&
      typeof result.conversationId === "string"
    ) {
      return { ok: true, conversationId: result.conversationId };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof RouteError) throw err;
    log.error(
      {
        err,
        conversationId: conversationId ?? undefined,
        surfaceId,
        actionId,
      },
      "Failed to handle surface action",
    );
    throw new InternalError("Failed to handle surface action");
  }
}

function handleSurfaceUndo({ body, pathParams }: RouteHandlerArgs) {
  const surfaceId = pathParams?.id;
  if (!surfaceId) {
    throw new BadRequestError("surfaceId path parameter is required");
  }

  const conversationId = body?.conversationId as string | null | undefined;
  if (conversationId != null && typeof conversationId !== "string") {
    throw new BadRequestError("conversationId must be a string");
  }

  const conversation = conversationId
    ? findConversation(conversationId)
    : findConversationBySurfaceId(surfaceId);

  if (!conversation) {
    throw new NotFoundError("No active conversation found");
  }

  if (!conversation.handleSurfaceUndo) {
    throw new InternalError(
      "Surface undo not supported for this conversation type",
    );
  }

  try {
    conversation.handleSurfaceUndo(surfaceId);
    log.info(
      { conversationId: conversationId ?? undefined, surfaceId },
      "Surface undo handled",
    );
    return { ok: true };
  } catch (err) {
    if (err instanceof RouteError) throw err;
    log.error(
      { err, conversationId: conversationId ?? undefined, surfaceId },
      "Failed to handle surface undo",
    );
    throw new InternalError("Failed to handle surface undo");
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "triggerSurfaceAction",
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
          "Id of a newly launched conversation when the action dispatched one. Omitted otherwise.",
        )
        .optional(),
    }),
    handler: handleSurfaceAction,
  },
  {
    operationId: "undoSurfaceAction",
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
    handler: handleSurfaceUndo,
  },
];

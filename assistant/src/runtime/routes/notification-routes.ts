/**
 * Route handlers for the notification pipeline and delivery acknowledgments.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../memory/db-connection.js";
import { notificationDeliveries } from "../../memory/schema.js";
import { bufferIfDeferred } from "../../notifications/deferred-emit.js";
import { editNotification } from "../../notifications/edit-notification.js";
import { emitNotificationSignal } from "../../notifications/emit-signal.js";
import { listEvents } from "../../notifications/events-store.js";
import type { AttentionHints } from "../../notifications/signal.js";
import { ACTOR_PRINCIPALS, LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

function handleNotificationIntentResult({ body = {} }: RouteHandlerArgs) {
  const { deliveryId, success, errorMessage, errorCode } = body as {
    deliveryId?: string;
    success?: boolean;
    errorMessage?: string;
    errorCode?: string;
  };

  if (!deliveryId || typeof deliveryId !== "string") {
    throw new BadRequestError("deliveryId is required");
  }

  const db = getDb();
  const now = Date.now();

  const updates: Record<string, unknown> = {
    clientDeliveryStatus: success ? "delivered" : "client_failed",
    clientDeliveryAt: now,
    updatedAt: now,
  };
  if (errorMessage) {
    updates.clientDeliveryError = errorMessage;
  }
  if (errorCode) {
    updates.errorCode = errorCode;
  }

  db.update(notificationDeliveries)
    .set(updates)
    .where(eq(notificationDeliveries.id, deliveryId))
    .run();

  return { ok: true };
}

// ── Notification pipeline schemas ─────────────────────────────────────

const AttentionHintsSchema = z.object({
  requiresAction: z.boolean(),
  urgency: z.enum(["low", "medium", "high", "critical"]),
  deadlineAt: z.number().optional(),
  isAsyncBackground: z.boolean(),
  visibleInSourceNow: z.boolean(),
});

const EmitSignalParams = z.object({
  sourceEventName: z.string().min(1),
  sourceChannel: z.enum([
    "assistant_tool",
    "vellum",
    "phone",
    "telegram",
    "slack",
    "scheduler",
    "watcher",
  ]),
  sourceContextId: z.string().min(1),
  attentionHints: AttentionHintsSchema,
  contextPayload: z.record(z.string(), z.unknown()).optional(),
  routingIntent: z
    .enum(["single_channel", "multi_channel", "all_channels"])
    .optional(),
  conversationAffinityHint: z.record(z.string(), z.string()).optional(),
  dedupeKey: z.string().optional(),
  throwOnError: z.boolean().optional(),
  // Conversation that originated this signal — used by `deferred-emit` to
  // buffer notifications during in-band background-job tool calls.
  originatingConversationId: z.string().optional(),
});

const ListNotificationEventsParams = z.object({
  limit: z.number().int().positive().optional(),
  sourceEventName: z.string().optional(),
});

const EditNotificationParams = z
  .object({
    id: z.string().min(1).describe("Feed item id (notif:<uuid>) or bare uuid"),
    title: z.string().optional(),
    body: z.string().optional(),
    urgency: z.enum(["low", "medium", "high", "critical"]).optional(),
    status: z.enum(["new", "seen", "acted_on", "dismissed"]).optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.body !== undefined ||
      v.urgency !== undefined ||
      v.status !== undefined,
    {
      message:
        "At least one of `title`, `body`, `urgency`, or `status` must be supplied",
    },
  );

// ── Notification pipeline handlers ───────────────────────────────────

async function handleEmitSignal({ body = {} }: RouteHandlerArgs) {
  const validated = EmitSignalParams.parse(body);
  const params = {
    sourceEventName: validated.sourceEventName,
    sourceChannel: validated.sourceChannel,
    sourceContextId: validated.sourceContextId,
    attentionHints: validated.attentionHints as AttentionHints,
    contextPayload: validated.contextPayload as Record<string, unknown>,
    routingIntent: validated.routingIntent,
    conversationAffinityHint: validated.conversationAffinityHint,
    dedupeKey: validated.dedupeKey,
    throwOnError: validated.throwOnError,
  };
  const buffered = bufferIfDeferred(
    validated.originatingConversationId,
    params,
  );
  if (buffered) {
    return {
      signalId: buffered.signalId,
      dispatched: buffered.dispatched,
      deduplicated: buffered.deduplicated,
      reason: buffered.reason,
    };
  }
  const result = await emitNotificationSignal(params);
  return {
    signalId: result.signalId,
    dispatched: result.dispatched,
    deduplicated: result.deduplicated,
    reason: result.reason,
  };
}

async function handleEditNotification({ body = {} }: RouteHandlerArgs) {
  const validated = EditNotificationParams.parse(body);
  const result = await editNotification(validated);
  if (!result) {
    throw new NotFoundError(`No notification found for id ${validated.id}`);
  }
  return {
    ok: true,
    feedItem: result.feedItem,
    channels: result.channels,
  };
}

function handleListEvents({ body = {} }: RouteHandlerArgs) {
  const validated = ListNotificationEventsParams.parse(body);
  const rows = listEvents({
    limit: validated.limit,
    sourceEventName: validated.sourceEventName,
  });
  return rows.map((row) => {
    let urgency = "unknown";
    try {
      const hints = JSON.parse(row.attentionHintsJson) as {
        urgency?: string;
      };
      if (hints.urgency) {
        urgency = hints.urgency;
      }
    } catch {
      // Leave urgency as "unknown" if parsing fails.
    }
    return {
      id: row.id,
      sourceEventName: row.sourceEventName,
      sourceChannel: row.sourceChannel,
      sourceContextId: row.sourceContextId,
      urgency,
      dedupeKey: row.dedupeKey,
      createdAt: new Date(row.createdAt).toISOString(),
    };
  });
}

// ── Routes ────────────────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "emit_notification_signal",
    endpoint: "notifications/emit",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleEmitSignal,
    summary: "Emit a notification signal",
    description:
      "Emit a notification signal into the pipeline for routing and delivery.",
    tags: ["notifications"],
    requestBody: EmitSignalParams,
    responseBody: z.object({
      signalId: z.string(),
      dispatched: z.boolean(),
      deduplicated: z.boolean(),
      reason: z.string(),
    }),
  },
  {
    operationId: "edit_notification",
    endpoint: "notifications/edit",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleEditNotification,
    summary: "Edit an already-sent notification",
    description:
      "Patch the home-feed entry for a notification and, where supported (Slack today), update the delivered message in place.",
    tags: ["notifications"],
    requestBody: EditNotificationParams,
    responseBody: z.object({
      ok: z.boolean(),
      feedItem: z.record(z.string(), z.unknown()),
      channels: z.array(
        z.object({
          channel: z.string(),
          deliveryId: z.string(),
          outcome: z.enum(["updated", "unsupported", "skipped", "failed"]),
          reason: z.string().optional(),
        }),
      ),
    }),
    additionalResponses: {
      "404": {
        description: "No notification found for the supplied id",
      },
    },
  },
  {
    operationId: "list_notification_events",
    endpoint: "notifications/events",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleListEvents,
    summary: "List notification events",
    description:
      "List recent notification events, optionally filtered by source event name.",
    tags: ["notifications"],
    requestBody: ListNotificationEventsParams,
    responseBody: z.array(
      z.object({
        id: z.string(),
        sourceEventName: z.string(),
        sourceChannel: z.string(),
        sourceContextId: z.string(),
        urgency: z.string(),
        dedupeKey: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  },
  {
    operationId: "notificationintentresult_post",
    endpoint: "notification-intent-result",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Report notification delivery result",
    description:
      "Client acknowledgment for local notification delivery outcome.",
    tags: ["notifications"],
    handler: handleNotificationIntentResult,
    requestBody: z.object({
      deliveryId: z.string().describe("Notification delivery ID"),
      success: z.boolean().describe("Whether delivery succeeded").optional(),
      errorMessage: z
        .string()
        .describe("Error message if delivery failed")
        .optional(),
      errorCode: z
        .string()
        .describe("Error code if delivery failed")
        .optional(),
    }),
    responseBody: z.object({
      ok: z.boolean(),
    }),
  },
];

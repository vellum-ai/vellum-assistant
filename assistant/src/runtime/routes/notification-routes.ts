/**
 * Route handlers for the notification pipeline and delivery acknowledgments.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";

import { FeedItemSchema } from "../../api/responses/home.js";
import { bufferIfDeferred } from "../../notifications/deferred-emit.js";
import { editNotification } from "../../notifications/edit-notification.js";
import { emitNotificationSignal } from "../../notifications/emit-signal.js";
import { listEvents } from "../../notifications/events-store.js";
import {
  AttentionHintsSchema,
  NotificationSourceChannelSchema,
  RoutingIntentSchema,
} from "../../notifications/signal.js";
import { UrgencySchema } from "../../notifications/urgency.js";
import { getDb } from "../../persistence/db-connection.js";
import { notificationDeliveries } from "../../persistence/schema/index.js";
import { ACTOR_PRINCIPALS, LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Notification intent result (client delivery ack) ──────────────────

const NotificationIntentResultParams = z.object({
  deliveryId: z.string().min(1).describe("Notification delivery ID"),
  success: z.boolean().describe("Whether delivery succeeded").optional(),
  errorMessage: z
    .string()
    .describe("Error message if delivery failed")
    .optional(),
  errorCode: z.string().describe("Error code if delivery failed").optional(),
});

function handleNotificationIntentResult({ body = {} }: RouteHandlerArgs) {
  const parsed = NotificationIntentResultParams.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("deliveryId is required");
  }
  const validated = parsed.data;

  const db = getDb();
  const now = Date.now();

  db.update(notificationDeliveries)
    .set({
      clientDeliveryStatus: validated.success ? "delivered" : "client_failed",
      clientDeliveryAt: now,
      updatedAt: now,
      ...(validated.errorMessage
        ? { clientDeliveryError: validated.errorMessage }
        : {}),
      ...(validated.errorCode ? { errorCode: validated.errorCode } : {}),
    })
    .where(eq(notificationDeliveries.id, validated.deliveryId))
    .run();

  return { ok: true };
}

// ── Emit signal ───────────────────────────────────────────────────────

const EmitSignalParams = z.object({
  sourceEventName: z.string().min(1),
  sourceChannel: NotificationSourceChannelSchema,
  sourceContextId: z.string().min(1),
  attentionHints: AttentionHintsSchema,
  contextPayload: z.record(z.string(), z.unknown()).optional(),
  routingIntent: RoutingIntentSchema.optional(),
  conversationAffinityHint: z.record(z.string(), z.string()).optional(),
  dedupeKey: z.string().optional(),
  throwOnError: z.boolean().optional(),
  originatingConversationId: z.string().optional(),
});

const EmitSignalResponse = z.object({
  signalId: z.string(),
  dispatched: z.boolean(),
  deduplicated: z.boolean(),
  reason: z.string(),
});

async function handleEmitSignal({ body = {} }: RouteHandlerArgs) {
  const parsed = EmitSignalParams.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues[0]?.message ?? "Invalid signal parameters",
    );
  }
  const validated = parsed.data;
  const buffered = bufferIfDeferred(
    validated.originatingConversationId,
    validated,
  );
  if (buffered) {
    return {
      signalId: buffered.signalId,
      dispatched: buffered.dispatched,
      deduplicated: buffered.deduplicated,
      reason: buffered.reason,
    };
  }
  const result = await emitNotificationSignal(validated);
  return {
    signalId: result.signalId,
    dispatched: result.dispatched,
    deduplicated: result.deduplicated,
    reason: result.reason,
  };
}

// ── Edit notification ─────────────────────────────────────────────────

const EditNotificationParams = z
  .object({
    id: z.string().min(1).describe("Feed item id (notif:<uuid>) or bare uuid"),
    title: z.string().optional(),
    body: z.string().optional(),
    urgency: UrgencySchema.optional(),
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

const ChannelEditOutcomeSchema = z.object({
  channel: z.string(),
  deliveryId: z.string(),
  outcome: z.enum(["updated", "unsupported", "skipped", "failed"]),
  reason: z.string().optional(),
});

const EditNotificationResponse = z.object({
  ok: z.boolean(),
  feedItem: FeedItemSchema,
  channels: z.array(ChannelEditOutcomeSchema),
});

async function handleEditNotification({ body = {} }: RouteHandlerArgs) {
  const parsed = EditNotificationParams.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues[0]?.message ?? "Invalid notification parameters",
    );
  }
  const validated = parsed.data;
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

// ── List events ───────────────────────────────────────────────────────

const ListNotificationEventsParams = z.object({
  limit: z.number().int().positive().optional(),
  sourceEventName: z.string().optional(),
});

const NotificationEventSchema = z.object({
  id: z.string(),
  sourceEventName: z.string(),
  sourceChannel: z.string(),
  sourceContextId: z.string(),
  urgency: z.string(),
  dedupeKey: z.string().nullable(),
  createdAt: z.string(),
});

function handleListEvents({ body = {} }: RouteHandlerArgs) {
  const parsed = ListNotificationEventsParams.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues[0]?.message ?? "Invalid query parameters",
    );
  }
  const validated = parsed.data;
  const rows = listEvents({
    limit: validated.limit,
    sourceEventName: validated.sourceEventName,
  });
  return rows.map((row) => {
    let urgency = "unknown";
    try {
      const hints = AttentionHintsSchema.parse(
        JSON.parse(row.attentionHintsJson),
      );
      urgency = hints.urgency;
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
    responseBody: EmitSignalResponse,
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
    responseBody: EditNotificationResponse,
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
    responseBody: z.array(NotificationEventSchema),
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
    requestBody: NotificationIntentResultParams,
    responseBody: z.object({
      ok: z.boolean(),
    }),
  },
];

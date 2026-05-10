/**
 * Route handlers for the notification pipeline and delivery acknowledgments.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../../memory/db-connection.js";
import { notificationDeliveries } from "../../memory/schema.js";
import { emitNotificationSignal } from "../../notifications/emit-signal.js";
import { listEvents } from "../../notifications/events-store.js";
import type { AttentionHints } from "../../notifications/signal.js";
import { BadRequestError } from "./errors.js";
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
  urgency: z.enum(["low", "medium", "high"]),
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
});

const ListNotificationEventsParams = z.object({
  limit: z.number().int().positive().optional(),
  sourceEventName: z.string().optional(),
});

// ── Notification pipeline handlers ───────────────────────────────────

async function handleEmitSignal({ body = {} }: RouteHandlerArgs) {
  const validated = EmitSignalParams.parse(body);
  const result = await emitNotificationSignal({
    sourceEventName: validated.sourceEventName,
    sourceChannel: validated.sourceChannel,
    sourceContextId: validated.sourceContextId,
    attentionHints: validated.attentionHints as AttentionHints,
    contextPayload: validated.contextPayload as Record<string, unknown>,
    routingIntent: validated.routingIntent,
    conversationAffinityHint: validated.conversationAffinityHint,
    dedupeKey: validated.dedupeKey,
    throwOnError: validated.throwOnError,
  });
  return {
    signalId: result.signalId,
    dispatched: result.dispatched,
    deduplicated: result.deduplicated,
    reason: result.reason,
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
    operationId: "list_notification_events",
    endpoint: "notifications/events",
    method: "POST",
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
    summary: "Report notification delivery result",
    description:
      "Client acknowledgment for local notification delivery outcome.",
    tags: ["notifications"],
    requirePolicyEnforcement: true,
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

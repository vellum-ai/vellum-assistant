/**
 * IPC routes for the notification pipeline.
 *
 * Exposes emit_notification_signal and list_notification_events so CLI
 * commands and external skill processes can drive the notification
 * pipeline over the Unix domain socket IPC.
 */

import { z } from "zod";

import { emitNotificationSignal } from "../../notifications/emit-signal.js";
import { listEvents } from "../../notifications/events-store.js";
import type { AttentionHints } from "../../notifications/signal.js";
import type { IpcRoute } from "../cli-server.js";

// ── Param schemas ─────────────────────────────────────────────────────

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
  dedupeKey: z.string().optional(),
  throwOnError: z.boolean().optional(),
});

const ListNotificationEventsParams = z.object({
  limit: z.number().int().positive().optional(),
  sourceEventName: z.string().optional(),
});

// ── Handlers ──────────────────────────────────────────────────────────

async function handleEmitSignal(params?: Record<string, unknown>): Promise<{
  signalId: string;
  dispatched: boolean;
  deduplicated: boolean;
  reason: string;
}> {
  const validated = EmitSignalParams.parse(params);
  const result = await emitNotificationSignal({
    sourceEventName: validated.sourceEventName,
    sourceChannel: validated.sourceChannel,
    sourceContextId: validated.sourceContextId,
    attentionHints: validated.attentionHints as AttentionHints,
    contextPayload: validated.contextPayload as Record<string, unknown>,
    routingIntent: validated.routingIntent,
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

function handleListEvents(params?: Record<string, unknown>): Array<{
  id: string;
  sourceEventName: string;
  sourceChannel: string;
  sourceContextId: string;
  urgency: string;
  dedupeKey: string | null;
  createdAt: string;
}> {
  const validated = ListNotificationEventsParams.parse(params);
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

// ── Route definitions ─────────────────────────────────────────────────

export const emitNotificationSignalRoute: IpcRoute = {
  method: "emit_notification_signal",
  handler: handleEmitSignal,
};

export const listNotificationEventsRoute: IpcRoute = {
  method: "list_notification_events",
  handler: handleListEvents,
};

/** All notification IPC routes. */
export const notificationRoutes: IpcRoute[] = [
  emitNotificationSignalRoute,
  listNotificationEventsRoute,
];

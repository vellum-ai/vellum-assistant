/**
 * `notification_intent` SSE event.
 *
 * Broadcast when a notification should be displayed. Clients turn it
 * into a local OS / in-app notification, filter guardian-scoped intents
 * to matching devices, and ack delivery back to the daemon.
 *
 * `silent` tells the client not to post the intent to the OS
 * notification surface (non-banner side effects still run); the server
 * sets it from the signal's urgency. `deepLinkMetadata` carries the
 * navigation target the client routes to on tap.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const NotificationIntentEventSchema = z.object({
  type: z.literal("notification_intent"),
  sourceEventName: z.string(),
  title: z.string(),
  body: z.string(),
  deliveryId: z.string().optional(),
  deepLinkMetadata: z.record(z.string(), z.unknown()).optional(),
  targetGuardianPrincipalId: z.string().optional(),
  silent: z.boolean().optional(),
});

export type NotificationIntentEvent = z.infer<
  typeof NotificationIntentEventSchema
>;

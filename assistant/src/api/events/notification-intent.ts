/**
 * `notification_intent` SSE event.
 *
 * Broadcast when a notification should be displayed. Clients turn it
 * into a local OS / in-app notification and ack delivery back to the
 * daemon. A guardian-scoped intent (`targetGuardianPrincipalId` set) is
 * delivered only to connections whose verified principal is that
 * guardian, so every client that receives one is meant to show it.
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
  /** Verified assistant name supplied by the assistant when available. */
  assistantName: z.string().optional(),
  title: z.string(),
  body: z.string(),
  deliveryId: z.string().optional(),
  correlationId: z.string().optional(),
  deepLinkMetadata: z.record(z.string(), z.unknown()).optional(),
  targetGuardianPrincipalId: z.string().optional(),
  silent: z.boolean().optional(),
  /**
   * True when the platform (APNs) channel accepted a remote push for
   * this delivery, so native clients can avoid double-bannering.
   */
  remotePushDispatched: z.boolean().optional(),
  /** Native platforms that accepted this remote push. */
  remotePushPlatforms: z.array(z.enum(["ios", "android"])).optional(),
});

export type NotificationIntentEvent = z.infer<
  typeof NotificationIntentEventSchema
>;

/**
 * `heartbeat_alert` SSE event.
 *
 * Server → client alert raised by the heartbeat monitor when a checked
 * condition needs the user's attention. Carries a `title` and `body`.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const HeartbeatAlertEventSchema = z.object({
  type: z.literal("heartbeat_alert"),
  title: z.string(),
  body: z.string(),
});

export type HeartbeatAlertEvent = z.infer<typeof HeartbeatAlertEventSchema>;

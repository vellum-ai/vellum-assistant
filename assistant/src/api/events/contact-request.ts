/**
 * `contact_request` SSE event.
 *
 * Server → client prompt asking the user to enter a contact channel
 * address (phone, email, etc.). Emitted by the `contacts/prompt` IPC
 * route while a `pendingContactPrompts` entry awaits a reply.
 *
 * Resolved by a paired `interaction_resolved` event (`kind:
 * "contact"`, `state: "answered" | "cancelled"`) once the user
 * responds or the timeout fires.
 *
 * `channel` and `role` are advisory hints, not enforced enums — the
 * client may render any input it likes and post back a structured
 * contact payload.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ContactRequestEventSchema = z.object({
  type: z.literal("contact_request"),
  requestId: z.string(),
  channel: z.string().optional(),
  placeholder: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  role: z.string().optional(),
});

export type ContactRequestEvent = z.infer<typeof ContactRequestEventSchema>;

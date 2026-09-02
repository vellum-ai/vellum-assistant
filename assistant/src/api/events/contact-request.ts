/**
 * `contact_request` SSE event.
 *
 * Server → client prompt asking the user to enter a contact channel
 * address (phone, email, etc.). Emitted by the `contacts/prompt` IPC
 * route while a `pendingContactPrompts` entry awaits a reply.
 *
 * The form closes when the user answers it, or with a
 * `contact_form_closed` event if it times out first. `interaction_resolved`
 * does not cover it: that event is conversation-scoped on the wire and is
 * deliberately not broadcast for a conversation-less interaction like this
 * one.
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
  defaultValue: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  role: z.string().optional(),
  /**
   * Initial state of the form's "mark verified" checkbox, from the CLI's
   * `--verify`. What the guardian submits is what gets attested.
   */
  verify: z.boolean().optional(),
});

export type ContactRequestEvent = z.infer<typeof ContactRequestEventSchema>;

/**
 * `contact_form_closed` SSE event.
 *
 * Tells every connected client that a contact form is over, so the card comes
 * down instead of sitting there offering to submit an answer the gateway will
 * now refuse.
 *
 * Both contact forms are workspace-global, broadcast without a conversation,
 * which is why this is its own event rather than `interaction_resolved`: that
 * one is conversation-scoped on the wire and is deliberately not broadcast for
 * a conversation-less interaction.
 *
 * Canonical wire-contract source. Daemon code imports the type directly from
 * this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ContactFormClosedEventSchema = z.object({
  type: z.literal("contact_form_closed"),
  requestId: z.string(),
  /**
   * Why it closed. Every client saw the form, so every client needs to know:
   * "answered" and "cancelled" retire the card on the clients that did not
   * answer it, and "timed_out" retires it on all of them.
   */
  reason: z.enum(["answered", "cancelled", "timed_out"]),
});

export type ContactFormClosedEvent = z.infer<
  typeof ContactFormClosedEventSchema
>;

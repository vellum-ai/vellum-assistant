/**
 * `contact_record_request` SSE event.
 *
 * Server to client form asking the guardian to confirm a contact record write
 * the assistant proposed: a create, an update, or a delete. Emitted by the
 * `contacts/record-prompt` IPC route while a `pendingContactPrompts` entry
 * awaits a reply.
 *
 * The proposed values are a starting point, not a decision. The guardian may
 * edit the name and notes before submitting, and the client posts the result
 * straight to the gateway, which owns the write.
 *
 * Resolved by a paired `interaction_resolved` event (`kind: "contact"`,
 * `state: "answered" | "cancelled"`) once the guardian responds or the
 * timeout fires.
 *
 * Canonical wire-contract source. Daemon code imports the type directly from
 * this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ContactRecordRequestEventSchema = z.object({
  type: z.literal("contact_record_request"),
  requestId: z.string(),
  operation: z.enum(["create", "update", "delete"]),
  /** Target of an update or delete. Absent on create. */
  contactId: z.string().optional(),
  /** Current name of the target, so the form can show what is changing. */
  currentDisplayName: z.string().optional(),
  /** Proposed name, prefilled into the form. */
  displayName: z.string().optional(),
  /** Proposed notes, prefilled into the form. */
  notes: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
});

export type ContactRecordRequestEvent = z.infer<
  typeof ContactRecordRequestEventSchema
>;

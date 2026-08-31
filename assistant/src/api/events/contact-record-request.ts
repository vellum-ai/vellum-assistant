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
 * The form closes when the guardian answers it, or with a
 * `contact_form_closed` event if it times out first. `interaction_resolved`
 * does not cover it: that event is conversation-scoped on the wire and is
 * deliberately not broadcast for a conversation-less interaction like this
 * one.
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
  /**
   * The target's current notes. The form submits a field only when it differs
   * from what is stored, so it needs what is stored to compare against.
   */
  currentNotes: z.string().optional(),
  /**
   * The target's channels, so a delete confirmation can say which of two
   * same-named contacts it is about, and what access is about to be lost.
   */
  channels: z
    .array(z.object({ type: z.string(), address: z.string() }))
    .optional(),

  /** Proposed name, prefilled into the form. */
  displayName: z.string().optional(),
  /** Proposed notes, prefilled into the form. */
  notes: z.string().optional(),
  /**
   * Whether the caller asked for these notes explicitly. A proposal that
   * happens to match what is stored is still a change the guardian confirmed,
   * and an unreadable mirror reports stored notes as empty, so the form cannot
   * tell "clear them" from "nothing to do" by comparison alone.
   */
  notesProposed: z.boolean().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
});

export type ContactRecordRequestEvent = z.infer<
  typeof ContactRecordRequestEventSchema
>;

/**
 * `contact_request` SSE event.
 *
 * Server → client prompt asking the user to enter a contact channel
 * address (phone, email, etc.). Emitted by the `contacts/prompt` IPC
 * route while a `pendingContactPrompts` entry awaits a reply.
 *
 * When `mode` is `"merge"`, the prompt instead asks the user to confirm
 * merging `discardId` into `keepId` — `keepName`/`discardName` are
 * provided so the client can render both contacts without a follow-up
 * lookup. The client renders a confirm/cancel UI rather than an address
 * input form.
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
  defaultValue: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  role: z.string().optional(),
  mode: z
    .literal("merge")
    .optional()
    .describe("When set, this is a merge-confirmation prompt."),
  keepId: z.string().optional().describe("Contact id to keep (merge mode)."),
  discardId: z
    .string()
    .optional()
    .describe("Contact id to merge away (merge mode)."),
  keepName: z
    .string()
    .optional()
    .describe("Display name of the contact to keep (merge mode)."),
  discardName: z
    .string()
    .optional()
    .describe("Display name of the contact to discard (merge mode)."),
});

export type ContactRequestEvent = z.infer<typeof ContactRequestEventSchema>;

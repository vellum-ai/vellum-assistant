/**
 * `contacts_changed` SSE event.
 *
 * Server → client invalidation signal: the contacts table has been
 * mutated (create / merge / delete / channel change). Carries no
 * payload — clients refetch their contact list on receipt.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ContactsChangedEventSchema = z.object({
  type: z.literal("contacts_changed"),
});

export type ContactsChangedEvent = z.infer<typeof ContactsChangedEventSchema>;

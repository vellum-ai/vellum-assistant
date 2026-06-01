/**
 * `identity_changed` SSE event.
 *
 * Broadcast when `IDENTITY.md` changes on disk. Clients refresh their cached
 * identity view; the fields here are the new authoritative identity, so a
 * client could apply them directly without a follow-up GET.
 *
 * Global event (no `conversationId`): identity is per-user, not
 * per-conversation, and the daemon fans this out across every active
 * client of the user.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const IdentityChangedEventSchema = z.object({
  type: z.literal("identity_changed"),
  /** Updated assistant name. */
  name: z.string(),
  /** Updated role / job description. */
  role: z.string(),
  /** Updated personality description. */
  personality: z.string(),
  /** Updated emoji glyph. */
  emoji: z.string(),
  /** Updated home / origin description. */
  home: z.string(),
});

export type IdentityChangedEvent = z.infer<typeof IdentityChangedEventSchema>;

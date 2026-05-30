/**
 * `avatar_updated` SSE event.
 *
 * Emitted after the avatar image has been regenerated and saved to disk.
 * Clients bust their avatar cache; the `avatarPath` is the absolute path
 * to the new image file, available to clients that read it directly.
 *
 * Global event (no `conversationId`): the avatar is per-user, not
 * per-conversation, and the daemon fans this out across every active
 * client of the user.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const AvatarUpdatedEventSchema = z.object({
  type: z.literal("avatar_updated"),
  /** Absolute path to the updated avatar image file. */
  avatarPath: z.string(),
});

export type AvatarUpdatedEvent = z.infer<typeof AvatarUpdatedEventSchema>;

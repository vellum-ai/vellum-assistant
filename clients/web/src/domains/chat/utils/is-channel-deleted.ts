import type { DisplayMessage } from "@/domains/chat/types/types";

/**
 * Whether the message was deleted on its channel after the daemon stored it.
 * The row keeps its content for Inspect; every renderer and merge step that
 * must treat the row as a tombstone reads this one predicate.
 */
export function isChannelDeleted(
  message: Pick<DisplayMessage, "deletedAt">,
): boolean {
  return message.deletedAt != null;
}

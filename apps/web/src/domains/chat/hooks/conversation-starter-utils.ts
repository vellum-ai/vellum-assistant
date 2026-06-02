/** Pure helper functions for conversation starters.
 *
 *  Separated from the React hook (`useConversationStarters`) so they
 *  can be unit-tested without a component render cycle. */

import type { ConversationStartersStatus } from "@/domains/chat/utils/conversation-starters";

const POLL_INTERVAL_MS = 3000;

/** Polling decision: returns the poll interval if the status indicates
 *  the daemon is still working, or `false` to stop polling. */
export function shouldPoll(
  status: ConversationStartersStatus | undefined,
): number | false {
  if (status === "generating" || status === "refreshing") {
    return POLL_INTERVAL_MS;
  }
  return false;
}

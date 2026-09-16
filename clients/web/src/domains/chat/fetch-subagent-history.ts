/**
 * Fetch a subagent's own conversation from the daemon, in the paginated
 * history shape the transcript fold advances.
 *
 * The whole conversation, with no `latestPageLimit`: a timeline pill can open
 * any call in the run, so a latest-page window would leave older pills with
 * no call to show.
 */

import { parsePaginatedResponse } from "@/domains/chat/api/history";
import { fetchConversationMessages } from "@/domains/chat/api/messages";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";

export async function fetchSubagentHistory(
  assistantId: string,
  conversationId: string,
): Promise<PaginatedHistoryResult> {
  return parsePaginatedResponse(
    await fetchConversationMessages(assistantId, conversationId),
  );
}

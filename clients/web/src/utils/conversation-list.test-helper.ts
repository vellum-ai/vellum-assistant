/**
 * Test helper for seeding conversation list caches.
 *
 * Every list cache holds a `ConversationListPage` (`{conversations,
 * hasMore}`), windowed or drained (LUM-2444). Tests that seed caches with
 * bare arrays would exercise a shape production code never reads, so this
 * is the one way tests build cache values: `hasMore` defaults to `false`
 * (a complete list), and tests exercising window semantics pass `true`
 * explicitly.
 */

import type { Conversation } from "@/types/conversation-types";
import type { ConversationListPage } from "@/utils/conversation-list-fetchers";

export function listPage(
  conversations: Conversation[],
  hasMore = false,
): ConversationListPage {
  return { conversations, hasMore };
}

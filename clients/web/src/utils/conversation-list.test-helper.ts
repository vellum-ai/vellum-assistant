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

import { QueryClient, type Query } from "@tanstack/react-query";

import type { Conversation } from "@/types/conversation-types";
import type { ConversationListPage } from "@/utils/conversation-list-fetchers";
import type { RawConversationSummary } from "@/utils/conversation-transforms";

export function listPage(
  conversations: Conversation[],
  hasMore = false,
): ConversationListPage {
  return { conversations, hasMore };
}

/**
 * A real `Query` for `queryKey`, so a test can run TanStack's own
 * `matchQuery` against a `queryClient` filter instead of reading key slots.
 * Built in `client` when given, so it is the same object the client holds.
 */
export function queryFor(
  queryKey: readonly unknown[],
  client: QueryClient = new QueryClient(),
): Query {
  return client.getQueryCache().build(client, { queryKey });
}

/** A raw wire row with the required fields defaulted, for daemon stubs. */
export type RawConversationFixture = Partial<RawConversationSummary> & {
  id: string;
};

/**
 * A raw conversation summary as the daemon returns it, for stubbing the
 * transport in tests: every required field defaulted, `overrides` on top.
 * Cast because the wire type is wider than what a list stub needs to say.
 */
export function rawConversation(
  overrides: RawConversationFixture,
): RawConversationSummary {
  return {
    title: "",
    createdAt: 0,
    updatedAt: 0,
    lastMessageAt: 0,
    conversationType: "standard",
    source: "vellum",
    groupId: null,
    isProcessing: false,
    ...overrides,
  } as RawConversationSummary;
}

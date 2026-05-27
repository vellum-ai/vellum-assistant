/**
 * Shared re-exports for cross-domain consumers that need conversation
 * data-fetching without importing from `domains/conversations/` directly.
 *
 * Lives in `lib/` because it wraps generated SDK calls with side effects.
 * Cross-domain pages (logs, settings) import from here instead of reaching
 * into `domains/conversations/`.
 */
export {
  conversationsQueryKey,
  listConversations,
  useConversationListQuery,
} from "@/domains/conversations/conversation-queries";

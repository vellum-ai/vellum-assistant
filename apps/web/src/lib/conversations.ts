/**
 * Shared re-export for cross-domain consumers that need conversation
 * data-fetching without importing from `domains/conversations/` directly.
 *
 * Lives in `lib/` because it wraps generated SDK calls with side effects.
 */
export { listConversations } from "@/domains/conversations/conversation-queries";

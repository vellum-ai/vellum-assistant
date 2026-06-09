// Re-export public types and utilities so existing consumers that import
// from `./reconcile` continue to work without changes.
export { dedupeDisplayMessages, messagesEqual } from "@/domains/chat/utils/message-merge";
export { sortByTimestamp, sortedByTimestamp, timestampToMs } from "@/domains/chat/utils/message-sorting";
export type { DisplayAttachment, DisplayMessage } from "@/domains/chat/types/types";

/**
 * Chat-domain diagnostic summarization helpers.
 *
 * Compact summaries of chat-specific types (DisplayMessage, ConversationMessage)
 * for the diagnostics ring buffer. Generic recording infrastructure lives
 * in `@/lib/diagnostics`.
 */

import type { DisplayMessage } from "@/domains/chat/types/types";
import type {
  ConversationContentBlock,
  ConversationMessage,
} from "@vellumai/assistant-api";
import { roleCounts } from "@/lib/diagnostics";

/**
 * Serialized size of a message's unified `contentBlocks` projection, in KB
 * (UTF-8 bytes, two-decimal precision). This is the migration's canonical
 * content payload, so its size is the meaningful weight of a row's body.
 */
function contentBlocksSizeKb(
  blocks: ConversationContentBlock[] | undefined,
): number {
  if (!blocks || blocks.length === 0) {
    return 0;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(blocks)).length;
  return Math.round((bytes / 1024) * 100) / 100;
}

export function summarizeDisplayMessage(message: DisplayMessage): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    contentBlocksKb: contentBlocksSizeKb(message.contentBlocks),
    timestamp: message.timestamp ?? null,
    queueStatus: message.queueStatus ?? null,
    queuePosition: message.queuePosition ?? null,
    toolCallCount: message.toolCalls?.length ?? 0,
    surfaceCount: message.surfaces?.length ?? 0,
    attachmentCount: message.attachments?.length ?? 0,
    textSegmentCount: message.textSegments?.length ?? 0,
    contentOrderCount: message.contentOrder?.length ?? 0,
  };
}

export function summarizeRuntimeMessage(message: ConversationMessage): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    contentBlocksKb: contentBlocksSizeKb(message.contentBlocks),
    timestamp: message.timestamp ?? null,
    toolCallCount: message.toolCalls?.length ?? 0,
    surfaceCount: message.surfaces?.length ?? 0,
    attachmentCount: message.attachments?.length ?? 0,
    textSegmentCount: message.textSegments?.length ?? 0,
    contentOrderCount: message.contentOrder?.length ?? 0,
  };
}

export function summarizeDisplayMessages(
  messages: DisplayMessage[],
  tailCount = 20,
): Record<string, unknown> {
  return {
    count: messages.length,
    roleCounts: roleCounts(messages),
    queuedCount: messages.filter((message) => message.queueStatus === "queued").length,
    processingCount: messages.filter((message) => message.queueStatus === "processing").length,
    first: messages[0] ? summarizeDisplayMessage(messages[0]) : null,
    last: messages.length > 0 ? summarizeDisplayMessage(messages[messages.length - 1]!) : null,
    tail: messages.slice(-tailCount).map(summarizeDisplayMessage),
  };
}

export function summarizeRuntimeMessages(
  messages: ConversationMessage[],
  tailCount = 20,
): Record<string, unknown> {
  return {
    count: messages.length,
    roleCounts: roleCounts(messages),
    first: messages[0] ? summarizeRuntimeMessage(messages[0]) : null,
    last: messages.length > 0 ? summarizeRuntimeMessage(messages[messages.length - 1]!) : null,
    tail: messages.slice(-tailCount).map(summarizeRuntimeMessage),
  };
}

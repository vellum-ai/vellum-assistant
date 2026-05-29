/**
 * Chat-domain diagnostic summarization helpers.
 *
 * These functions produce compact summaries of chat-specific types
 * (DisplayMessage, RuntimeMessage) for the diagnostics ring buffer.
 * The generic recording infrastructure lives in `utils/diagnostics.ts`.
 */

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import type { RuntimeMessage } from "@/domains/chat/api/messages";
import { roleCounts } from "@/utils/diagnostics";

// Re-export generic diagnostics for backwards-compatible imports within
// the chat domain. New code should import from `@/utils/diagnostics` directly.
export {
  type DiagnosticsEvent as ChatDiagnosticsEvent,
  recordDiagnostic as recordChatDiagnostic,
  resolvePlatformTag,
  getDiagnosticsEvents as getChatDiagnosticsEvents,
  buildDiagnosticsSnapshot as buildChatDiagnosticsSnapshot,
  bucketMessagesAdded,
  summarizeAssistantEvent,
} from "@/utils/diagnostics";

export function summarizeDisplayMessage(message: DisplayMessage): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    contentLength: message.content.length,
    timestamp: message.timestamp ?? null,
    isStreaming: message.isStreaming === true,
    queueStatus: message.queueStatus ?? null,
    queuePosition: message.queuePosition ?? null,
    toolCallCount: message.toolCalls?.length ?? 0,
    surfaceCount: message.surfaces?.length ?? 0,
    attachmentCount: message.attachments?.length ?? 0,
    textSegmentCount: message.textSegments?.length ?? 0,
    contentOrderCount: message.contentOrder?.length ?? 0,
  };
}

export function summarizeRuntimeMessage(message: RuntimeMessage): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    contentLength: message.content.length,
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
    streamingCount: messages.filter((message) => message.isStreaming).length,
    queuedCount: messages.filter((message) => message.queueStatus === "queued").length,
    processingCount: messages.filter((message) => message.queueStatus === "processing").length,
    first: messages[0] ? summarizeDisplayMessage(messages[0]) : null,
    last: messages.length > 0 ? summarizeDisplayMessage(messages[messages.length - 1]!) : null,
    tail: messages.slice(-tailCount).map(summarizeDisplayMessage),
  };
}

export function summarizeRuntimeMessages(
  messages: RuntimeMessage[],
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

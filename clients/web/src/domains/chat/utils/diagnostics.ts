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

interface ContentBlockSizeSummary {
  contentBlocksKb: number;
  inlineMediaKb: number;
  inlineMediaCount: number;
}

const UTF8_ENCODER = new TextEncoder();

function roundKb(bytes: number): number {
  return Math.round((bytes / 1024) * 100) / 100;
}

function isAttachmentMetadata(value: unknown): value is object {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "filename" in value &&
    "mimeType" in value &&
    "sizeBytes" in value
  );
}

/**
 * Measures serialized `contentBlocks` after replacing base64 payloads with
 * empty markers, then adds their ASCII lengths back into the total.
 */
function summarizeContentBlockSize(
  blocks: ConversationContentBlock[] | undefined,
): ContentBlockSizeSummary {
  if (!blocks || blocks.length === 0) {
    return {
      contentBlocksKb: 0,
      inlineMediaKb: 0,
      inlineMediaCount: 0,
    };
  }

  let inlineMediaBytes = 0;
  let inlineMediaCount = 0;
  const redactInlineMedia = (value: string): string => {
    inlineMediaBytes += value.length;
    inlineMediaCount++;
    return "";
  };
  const redacted = JSON.stringify(blocks, function (
    this: unknown,
    key,
    value: unknown,
  ) {
    if (key === "imageDataList" && Array.isArray(value)) {
      return value.map((item) =>
        typeof item === "string" ? redactInlineMedia(item) : item,
      );
    }
    if (
      typeof value === "string" &&
      (key === "imageData" ||
        (isAttachmentMetadata(this) &&
          (key === "data" || key === "thumbnailData")))
    ) {
      return redactInlineMedia(value);
    }
    return value;
  });
  const redactedBytes = UTF8_ENCODER.encode(redacted).length;
  return {
    contentBlocksKb: roundKb(redactedBytes + inlineMediaBytes),
    inlineMediaKb: roundKb(inlineMediaBytes),
    inlineMediaCount,
  };
}

export function summarizeDisplayMessage(message: DisplayMessage): Record<string, unknown> {
  const contentBlockSize = summarizeContentBlockSize(message.contentBlocks);
  return {
    id: message.id,
    role: message.role,
    ...contentBlockSize,
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
  const contentBlockSize = summarizeContentBlockSize(message.contentBlocks);
  return {
    id: message.id,
    role: message.role,
    ...contentBlockSize,
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

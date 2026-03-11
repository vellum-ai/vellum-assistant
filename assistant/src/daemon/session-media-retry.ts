/**
 * Media payload trimming for context-too-large retry scenarios.
 *
 * When the provider rejects a request because the context is too large,
 * this module replaces older image and file content blocks with lightweight
 * text stubs to shrink the payload before retrying.
 */

import { getSummaryFromContextMessage } from "../context/window-manager.js";
import type { ContentBlock, Message } from "../providers/types.js";

const RETRY_KEEP_LATEST_MEDIA_BLOCKS = 3;
const MAX_MEDIA_STUB_TEXT = 2_000;

export function stripMediaPayloadsForRetry(messages: Message[]): {
  messages: Message[];
  modified: boolean;
  replacedBlocks: number;
  latestUserIndex: number | null;
} {
  let latestUserIndex: number | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    if (isToolResultOnlyMessage(msg)) continue;
    if (getSummaryFromContextMessage(msg) != null) continue;
    latestUserIndex = i;
    break;
  }

  let modified = false;
  let replacedBlocks = 0;
  let keptLatestMediaBlocks = 0;

  const nextMessages = messages.map((msg, msgIndex) => {
    const nextContent: ContentBlock[] = [];
    for (const block of msg.content) {
      // Top-level image blocks are user-uploaded attachments. Keep the latest
      // few (in the most recent user message) and strip older ones so the
      // retry can actually reduce context size when images are the cause.
      if (block.type === "image") {
        const keep =
          latestUserIndex === msgIndex &&
          keptLatestMediaBlocks < RETRY_KEEP_LATEST_MEDIA_BLOCKS;
        if (keep) {
          keptLatestMediaBlocks += 1;
          nextContent.push(block);
        } else {
          replacedBlocks += 1;
          modified = true;
          nextContent.push(imageBlockToStub(block));
        }
        continue;
      }

      if (block.type === "file") {
        const keep =
          latestUserIndex === msgIndex &&
          keptLatestMediaBlocks < RETRY_KEEP_LATEST_MEDIA_BLOCKS;
        if (keep) {
          keptLatestMediaBlocks += 1;
          nextContent.push(block);
        } else {
          replacedBlocks += 1;
          modified = true;
          nextContent.push(fileBlockToStub(block));
        }
        continue;
      }

      if (
        block.type === "tool_result" &&
        block.contentBlocks &&
        block.contentBlocks.length > 0
      ) {
        let toolResultChanged = false;
        const nextToolContentBlocks: ContentBlock[] = block.contentBlocks.map(
          (cb) => {
            if (cb.type === "image") {
              replacedBlocks += 1;
              modified = true;
              toolResultChanged = true;
              return imageBlockToStub(cb);
            }
            if (cb.type === "file") {
              replacedBlocks += 1;
              modified = true;
              toolResultChanged = true;
              return fileBlockToStub(cb);
            }
            return cb;
          },
        );
        if (toolResultChanged) {
          nextContent.push({ ...block, contentBlocks: nextToolContentBlocks });
        } else {
          nextContent.push(block);
        }
        continue;
      }

      nextContent.push(block);
    }
    return { ...msg, content: nextContent };
  });

  return {
    messages: modified ? nextMessages : messages,
    modified,
    replacedBlocks,
    latestUserIndex,
  };
}

function imageBlockToStub(
  block: Extract<ContentBlock, { type: "image" }>,
): Extract<ContentBlock, { type: "text" }> {
  const sizeBytes = Math.ceil(block.source.data.length / 4) * 3;
  return {
    type: "text",
    text: `[Image omitted from retry context: ${block.source.media_type}, ${sizeBytes} bytes]`,
  };
}

function fileBlockToStub(
  block: Extract<ContentBlock, { type: "file" }>,
): Extract<ContentBlock, { type: "text" }> {
  const sizeBytes = Math.ceil(block.source.data.length / 4) * 3;
  const extracted = (block.extracted_text ?? "").trim();
  const preview =
    extracted.length > MAX_MEDIA_STUB_TEXT
      ? `${extracted.slice(0, MAX_MEDIA_STUB_TEXT)}...`
      : extracted;
  return {
    type: "text",
    text:
      preview.length > 0
        ? `[File omitted from retry context: ${block.source.filename} (${block.source.media_type}, ${sizeBytes} bytes)]\n${preview}`
        : `[File omitted from retry context: ${block.source.filename} (${block.source.media_type}, ${sizeBytes} bytes)]`,
  };
}

function isToolResultOnlyMessage(message: Message): boolean {
  return (
    message.content.length > 0 &&
    message.content.every((block) => block.type === "tool_result")
  );
}

/**
 * Count how many media (image/file) content blocks exist across a message
 * history, both top-level and nested inside tool_result blocks.
 */
export function countMediaBlocks(messages: Message[]): number {
  let count = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "image" || block.type === "file") {
        count++;
      } else if (block.type === "tool_result" && block.contentBlocks) {
        for (const cb of block.contentBlocks) {
          if (cb.type === "image" || cb.type === "file") {
            count++;
          }
        }
      }
    }
  }
  return count;
}

/**
 * Race a promise against a timeout. Returns 'completed' if the promise
 * resolves/rejects within the budget, or 'timed_out' if the timeout fires
 * first. The timer is always cleared in `finally` to prevent handle leaks.
 */
export async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<"completed" | "timed_out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      promise.then(
        () => "completed" as const,
        () => "completed" as const,
      ),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), timeoutMs);
      }),
    ]);
    return result;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

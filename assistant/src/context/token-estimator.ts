import type { ContentBlock, Message } from "../providers/types.js";

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_TOKENS = 4;
const TEXT_BLOCK_OVERHEAD_TOKENS = 2;
const TOOL_BLOCK_OVERHEAD_TOKENS = 16;
const IMAGE_BLOCK_TOKENS = 1024;
const IMAGE_BLOCK_OVERHEAD_TOKENS = 16;
const FILE_BLOCK_OVERHEAD_TOKENS = 48;
const WEB_SEARCH_RESULT_TOKENS = 800;
const OTHER_BLOCK_TOKENS = 16;
const SYSTEM_PROMPT_OVERHEAD_TOKENS = 8;
const GEMINI_INLINE_FILE_MIME_TYPES = new Set(["application/pdf"]);

export interface TokenEstimatorOptions {
  providerName?: string;
}

export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function shouldCountFileSourceData(
  block: Extract<ContentBlock, { type: "file" }>,
  options?: TokenEstimatorOptions,
): boolean {
  if (options?.providerName !== "gemini") {
    return false;
  }
  return GEMINI_INLINE_FILE_MIME_TYPES.has(block.source.media_type);
}

function estimateImageSourceDataTokens(
  block: Extract<ContentBlock, { type: "image" }>,
): number {
  // Image payloads are carried inline as base64 for all currently supported
  // providers, so estimator must scale with payload size (not fixed per image).
  return estimateTextTokens(block.source.data);
}

export function estimateContentBlockTokens(
  block: ContentBlock,
  options?: TokenEstimatorOptions,
): number {
  switch (block.type) {
    case "text":
      return TEXT_BLOCK_OVERHEAD_TOKENS + estimateTextTokens(block.text);
    case "tool_use":
      return (
        TOOL_BLOCK_OVERHEAD_TOKENS +
        estimateTextTokens(block.name) +
        estimateTextTokens(stableJson(block.input))
      );
    case "tool_result": {
      let tokens =
        TOOL_BLOCK_OVERHEAD_TOKENS +
        estimateTextTokens(block.tool_use_id) +
        estimateTextTokens(block.content);
      if (block.contentBlocks) {
        for (const cb of block.contentBlocks) {
          tokens += estimateContentBlockTokens(cb, options);
        }
      }
      return tokens;
    }
    case "image":
      return Math.max(
        IMAGE_BLOCK_TOKENS,
        IMAGE_BLOCK_OVERHEAD_TOKENS +
          estimateTextTokens(block.source.media_type) +
          estimateImageSourceDataTokens(block),
      );
    case "file":
      return (
        FILE_BLOCK_OVERHEAD_TOKENS +
        estimateTextTokens(block.source.filename) +
        estimateTextTokens(block.source.media_type) +
        (shouldCountFileSourceData(block, options)
          ? estimateTextTokens(block.source.data)
          : 0) +
        estimateTextTokens(block.extracted_text ?? "")
      );
    case "thinking":
      return TEXT_BLOCK_OVERHEAD_TOKENS + estimateTextTokens(block.thinking);
    case "redacted_thinking":
      return TEXT_BLOCK_OVERHEAD_TOKENS + estimateTextTokens(block.data);
    case "server_tool_use":
      return (
        TOOL_BLOCK_OVERHEAD_TOKENS +
        estimateTextTokens(block.name) +
        estimateTextTokens(stableJson(block.input))
      );
    case "web_search_tool_result":
      return (
        WEB_SEARCH_RESULT_TOKENS + estimateTextTokens(stableJson(block.content))
      );
    default:
      return OTHER_BLOCK_TOKENS;
  }
}

export function estimateMessageTokens(
  message: Message,
  options?: TokenEstimatorOptions,
): number {
  let total = MESSAGE_OVERHEAD_TOKENS;
  for (const block of message.content) {
    total += estimateContentBlockTokens(block, options);
  }
  return total;
}

export function estimateMessagesTokens(
  messages: Message[],
  options?: TokenEstimatorOptions,
): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message, options);
  }
  return total;
}

export function estimatePromptTokens(
  messages: Message[],
  systemPrompt?: string,
  options?: TokenEstimatorOptions,
): number {
  const systemTokens = systemPrompt
    ? SYSTEM_PROMPT_OVERHEAD_TOKENS + estimateTextTokens(systemPrompt)
    : 0;
  return systemTokens + estimateMessagesTokens(messages, options);
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "<unserializable />";
  }
}

import type { ContentBlock, Message } from "../providers/types.js";
import { parseImageDimensions } from "./image-dimensions.js";

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

// Anthropic scales images to fit within 1568x1568 maintaining aspect ratio,
// then charges ~(width * height) / 750 tokens.
const ANTHROPIC_IMAGE_MAX_DIMENSION = 1568;
const ANTHROPIC_IMAGE_TOKENS_PER_PIXEL = 1 / 750;
const ANTHROPIC_IMAGE_MAX_TOKENS = Math.ceil(
  ANTHROPIC_IMAGE_MAX_DIMENSION *
    ANTHROPIC_IMAGE_MAX_DIMENSION *
    ANTHROPIC_IMAGE_TOKENS_PER_PIXEL,
); // ~3,277 tokens

// Anthropic renders each PDF page as an image (~1,568 tokens at standard
// resolution) plus any extracted text. Typical PDF pages are 50-150 KB.
// Using ~100 KB/page and ~1,600 tokens/page gives ~0.016 tokens/byte.
const ANTHROPIC_PDF_TOKENS_PER_BYTE = 0.016;
const ANTHROPIC_PDF_MIN_TOKENS = 1600; // At least one page

export interface TokenEstimatorOptions {
  providerName?: string;
}

export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateAnthropicPdfTokens(base64Data: string): number {
  const rawBytes = Math.ceil((base64Data.length * 3) / 4);
  return Math.max(
    ANTHROPIC_PDF_MIN_TOKENS,
    Math.ceil(rawBytes * ANTHROPIC_PDF_TOKENS_PER_BYTE),
  );
}

function estimateFileDataTokens(
  block: Extract<ContentBlock, { type: "file" }>,
  options?: TokenEstimatorOptions,
): number {
  const providerName = options?.providerName;

  // Anthropic sends PDFs as native document blocks and renders each page as an image
  if (
    providerName === "anthropic" &&
    block.source.media_type === "application/pdf"
  ) {
    return estimateAnthropicPdfTokens(block.source.data);
  }

  // Gemini sends certain file types inline as base64
  if (
    providerName === "gemini" &&
    GEMINI_INLINE_FILE_MIME_TYPES.has(block.source.media_type)
  ) {
    return estimateTextTokens(block.source.data);
  }

  return 0;
}

function estimateAnthropicImageTokens(width: number, height: number): number {
  // Scale down to fit within 1568x1568 bounding box, maintaining aspect ratio
  const scale = Math.min(
    1,
    ANTHROPIC_IMAGE_MAX_DIMENSION / Math.max(width, height),
  );
  const scaledWidth = Math.round(width * scale);
  const scaledHeight = Math.round(height * scale);
  return Math.max(
    IMAGE_BLOCK_TOKENS, // minimum 1024
    Math.ceil(scaledWidth * scaledHeight * ANTHROPIC_IMAGE_TOKENS_PER_PIXEL),
  );
}

function estimateImageTokens(
  block: Extract<ContentBlock, { type: "image" }>,
  options?: TokenEstimatorOptions,
): number {
  if (options?.providerName === "anthropic") {
    const dims = parseImageDimensions(
      block.source.data,
      block.source.media_type,
    );
    if (dims) {
      return estimateAnthropicImageTokens(dims.width, dims.height);
    }
    // Fallback: if dimensions can't be parsed, use Anthropic's max
    return ANTHROPIC_IMAGE_MAX_TOKENS;
  }
  // Non-Anthropic: keep existing base64-size heuristic
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
          estimateImageTokens(block, options),
      );
    case "file":
      return (
        FILE_BLOCK_OVERHEAD_TOKENS +
        estimateTextTokens(block.source.filename) +
        estimateTextTokens(block.source.media_type) +
        estimateFileDataTokens(block, options) +
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

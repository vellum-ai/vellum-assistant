import type {
  ContentBlock,
  Message,
  ToolDefinition,
} from "../providers/types.js";
import { parseImageDimensions } from "./image-dimensions.js";

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_TOKENS = 4;
const TEXT_BLOCK_OVERHEAD_TOKENS = 2;
const TOOL_BLOCK_OVERHEAD_TOKENS = 16;
const IMAGE_BLOCK_OVERHEAD_TOKENS = 16;
const FILE_BLOCK_OVERHEAD_TOKENS = 48;
const WEB_SEARCH_RESULT_TOKENS = 800;
const OTHER_BLOCK_TOKENS = 16;
const SYSTEM_PROMPT_OVERHEAD_TOKENS = 8;
const GEMINI_INLINE_FILE_MIME_TYPES = new Set(["application/pdf"]);

// Anthropic scales images to fit within 1568x1568 maintaining aspect ratio,
// then charges ~(width * height) / 750 tokens.
const ANTHROPIC_IMAGE_MAX_DIMENSION = 1568;
// Anthropic caps images at ~1.2 megapixels in addition to the 1568px dimension limit.
// Images exceeding this are further scaled down. The docs state images above ~1,600 tokens
// are resized. 1,200,000 / 750 = 1,600 tokens, matching the documented threshold.
// Reference table (max sizes that won't be resized):
//   1:1 → 1092x1092 (~1,590 tokens)   1:2 → 784x1568 (~1,639 tokens)
// See: https://platform.claude.com/docs/en/build-with-claude/vision#evaluate-image-size
const ANTHROPIC_IMAGE_MAX_PIXELS = 1_200_000;
const ANTHROPIC_IMAGE_TOKENS_PER_PIXEL = 1 / 750;
const ANTHROPIC_IMAGE_MAX_TOKENS = 1_600;

// Anthropic renders each PDF page as an image (~1,568 tokens at standard
// resolution) plus any extracted text. Typical PDF pages are 50-150 KB.
// Using ~100 KB/page and ~1,600 tokens/page gives ~0.016 tokens/byte.
const ANTHROPIC_PDF_TOKENS_PER_BYTE = 0.016;
const ANTHROPIC_PDF_MIN_TOKENS = 1600; // At least one page

// Anthropic wraps each tool definition in XML internally, adding overhead
// beyond the raw JSON schema. Empirically measured at ~132 tokens/tool via
// the countTokens API, but the overhead varies by schema complexity.
// We use per-tool estimation (JSON schema size) plus a fixed XML-wrapping
// overhead to approximate the actual cost.
const TOOL_DEFINITION_OVERHEAD_TOKENS = 28;

export interface TokenEstimatorOptions {
  providerName?: string;
  /** Pre-computed tool token budget. When provided, added to the prompt total. */
  toolTokenBudget?: number;
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
  // Step 1: Scale to fit within 1568px bounding box
  const dimScale = Math.min(
    1,
    ANTHROPIC_IMAGE_MAX_DIMENSION / Math.max(width, height),
  );
  let scaledWidth = Math.round(width * dimScale);
  let scaledHeight = Math.round(height * dimScale);

  // Step 2: Scale further if exceeds megapixel budget
  const pixels = scaledWidth * scaledHeight;
  if (pixels > ANTHROPIC_IMAGE_MAX_PIXELS) {
    const mpScale = Math.sqrt(ANTHROPIC_IMAGE_MAX_PIXELS / pixels);
    scaledWidth = Math.round(scaledWidth * mpScale);
    scaledHeight = Math.round(scaledHeight * mpScale);
  }

  return Math.ceil(
    scaledWidth * scaledHeight * ANTHROPIC_IMAGE_TOKENS_PER_PIXEL,
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
      // Mirror the Anthropic serializer in providers/anthropic/client.ts
      // (toAnthropicBlockSafe): block.content is always sent as the first
      // text part, and contentBlocks are appended — but only `image` and
      // `text` sub-blocks survive, and `image` is filtered out when
      // is_error is true. Counting every contentBlocks entry regardless
      // of type overestimates the wire size and can trigger spurious
      // compaction on conversations that carry e.g. thinking sub-blocks.
      // OpenAI and Gemini forward error-result images normally, so the
      // is_error image drop is Anthropic-specific.
      const anthropicDropsErrorImage =
        options?.providerName === "anthropic" && block.is_error === true;
      let tokens =
        TOOL_BLOCK_OVERHEAD_TOKENS +
        estimateTextTokens(block.tool_use_id) +
        estimateTextTokens(block.content);
      if (block.contentBlocks) {
        for (const cb of block.contentBlocks) {
          if (cb.type === "text") {
            tokens += estimateContentBlockTokens(cb, options);
          } else if (cb.type === "image" && !anthropicDropsErrorImage) {
            tokens += estimateContentBlockTokens(cb, options);
          }
        }
      }
      return tokens;
    }
    case "image":
      return (
        IMAGE_BLOCK_OVERHEAD_TOKENS +
        estimateTextTokens(block.source.media_type) +
        estimateImageTokens(block, options)
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

/** Estimate token cost for a single tool definition. */
export function estimateToolDefinitionTokens(tool: ToolDefinition): number {
  return (
    TOOL_DEFINITION_OVERHEAD_TOKENS +
    estimateTextTokens(tool.name) +
    estimateTextTokens(tool.description) +
    estimateTextTokens(stableJson(tool.input_schema))
  );
}

/** Estimate total token cost for an array of tool definitions. */
export function estimateToolsTokens(tools: ToolDefinition[]): number {
  let total = 0;
  for (const tool of tools) {
    total += estimateToolDefinitionTokens(tool);
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
  const toolTokens = options?.toolTokenBudget ?? 0;
  return systemTokens + toolTokens + estimateMessagesTokens(messages, options);
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "<unserializable />";
  }
}

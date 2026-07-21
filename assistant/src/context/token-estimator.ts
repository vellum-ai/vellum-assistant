import {
  estimateGeminiAudioTokens,
  normalizeGeminiAudioMime,
} from "../providers/gemini/inline-media.js";
import { mediaSourceByteLength } from "../providers/media-resolve.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ToolDefinition,
} from "../providers/types.js";
import { getCorrection } from "./estimator-calibration.js";
import { parseImageDimensions } from "./image-dimensions.js";

/**
 * Canonical provider key used for calibration lookups and updates. Wrapper
 * providers (e.g. OpenRouter routing `anthropic/*` traffic to the Messages
 * API) set `tokenEstimationProvider` to the upstream provider name so the
 * calibration key matches the one used when the provider actually produces
 * the response. Falls back to `name` when the wrapper hint is unset.
 *
 * Every caller that records a sample or applies a correction must use this
 * helper — otherwise wrapper-provider data is scattered across mismatched
 * keys and the calibration becomes a no-op.
 */
export function getCalibrationProviderKey(provider: Provider): string {
  return provider.tokenEstimationProvider ?? provider.name;
}

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

// Dimension-based image token estimate, used as a universal default for every
// provider. The formula and constants below come from Anthropic's published
// vision spec — scale to a 1568x1568 bounding box, then charge
// ~(width * height) / 750 tokens, with a ~1.2-megapixel cap that lands at
// ~1,600 tokens per image. Reference table (max sizes that won't be resized):
//   1:1 → 1092x1092 (~1,590 tokens)   1:2 → 784x1568 (~1,639 tokens)
// See: https://platform.claude.com/docs/en/build-with-claude/vision#evaluate-image-size
//
// Other multimodal providers (OpenAI/GPT-4V tile pricing, Moonshot/Kimi,
// Gemini fixed-cost, OpenRouter pass-through) price differently in detail,
// but every published rate lands in the same hundreds-to-low-thousands range
// per image. Using this formula as the default gets compaction within ~2-3x
// of reality instead of the ~30-100x over-counting produced by treating the
// raw base64 payload as if it were text.
const IMAGE_MAX_DIMENSION = 1568;
const IMAGE_MAX_PIXELS = 1_200_000;
const IMAGE_TOKENS_PER_PIXEL = 1 / 750;
const IMAGE_MAX_TOKENS = 1_600;

// Gemini prices images differently: any side ≤384px counts as a single 258-token
// tile; anything larger is resized so the longest side is ≤3072px and then
// split into 768x768 tiles at 258 tokens each. A 4000x4000 image clamps to
// 3072x3072 → ceil(3072/768)^2 = 16 tiles = 4,128 tokens. Without the clamp
// we'd over-count it as 36 tiles (~9,288 tokens) and trigger spurious
// compaction. The clamped 16-tile, 4,128-token figure is also the per-image
// ceiling we fall back to when dimensions are unparseable (e.g. HEIC/HEIF
// from iOS attachments) — the generic 1,600 cap can under-count Gemini
// images by ~2.5x.
// See: https://ai.google.dev/gemini-api/docs/tokens#multimodal-tokens
const GEMINI_IMAGE_SMALL_THRESHOLD = 384;
const GEMINI_IMAGE_TILE_SIZE = 768;
const GEMINI_IMAGE_TOKENS_PER_TILE = 258;
const GEMINI_IMAGE_MAX_DIMENSION = 3072;
const GEMINI_IMAGE_MAX_TOKENS =
  Math.ceil(GEMINI_IMAGE_MAX_DIMENSION / GEMINI_IMAGE_TILE_SIZE) ** 2 *
  GEMINI_IMAGE_TOKENS_PER_TILE;

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

export function estimateTextTokens(text: string | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateAnthropicPdfTokens(rawBytes: number): number {
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
  // Size the payload from the source hint, resolving neither base64 nor a
  // reference back to bytes — this runs on the per-turn hot path.
  const byteLength = mediaSourceByteLength(block.source);

  // Anthropic sends PDFs as native document blocks and renders each page as an image
  if (
    providerName === "anthropic" &&
    block.source.media_type === "application/pdf"
  ) {
    return estimateAnthropicPdfTokens(byteLength);
  }

  // Gemini hears audio natively (inline base64) but bills it at ~32 tokens/sec.
  // Estimate from duration, not payload size, to avoid a ~170x over-count that
  // would trigger spurious compaction.
  if (
    providerName === "gemini" &&
    normalizeGeminiAudioMime(block.source.media_type) !== null
  ) {
    return estimateGeminiAudioTokens(byteLength);
  }

  // Gemini sends certain file types inline as base64; cost the encoded payload
  // (~4 base64 chars per 3 bytes) as text.
  if (
    providerName === "gemini" &&
    GEMINI_INLINE_FILE_MIME_TYPES.has(block.source.media_type)
  ) {
    return Math.ceil((Math.ceil(byteLength / 3) * 4) / CHARS_PER_TOKEN);
  }

  return 0;
}

function estimateImageTokensByDimensions(
  width: number,
  height: number,
): number {
  // Step 1: Scale to fit within 1568px bounding box
  const dimScale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(width, height));
  let scaledWidth = Math.round(width * dimScale);
  let scaledHeight = Math.round(height * dimScale);

  // Step 2: Scale further if exceeds megapixel budget
  const pixels = scaledWidth * scaledHeight;
  if (pixels > IMAGE_MAX_PIXELS) {
    const mpScale = Math.sqrt(IMAGE_MAX_PIXELS / pixels);
    scaledWidth = Math.round(scaledWidth * mpScale);
    scaledHeight = Math.round(scaledHeight * mpScale);
  }

  return Math.ceil(scaledWidth * scaledHeight * IMAGE_TOKENS_PER_PIXEL);
}

function estimateGeminiImageTokens(width: number, height: number): number {
  if (
    width <= GEMINI_IMAGE_SMALL_THRESHOLD &&
    height <= GEMINI_IMAGE_SMALL_THRESHOLD
  ) {
    return GEMINI_IMAGE_TOKENS_PER_TILE;
  }
  // Gemini rescales both dimensions by a single aspect-preserving factor so
  // the longest side is ≤3072px before tiling. Clamping each side
  // independently would over-count tiles for extreme aspect ratios
  // (e.g. 10000×1000 → 3072×307, not 3072×1000).
  const scale = Math.min(
    1,
    GEMINI_IMAGE_MAX_DIMENSION / Math.max(width, height),
  );
  const tilesWide = Math.ceil((width * scale) / GEMINI_IMAGE_TILE_SIZE);
  const tilesHigh = Math.ceil((height * scale) / GEMINI_IMAGE_TILE_SIZE);
  return tilesWide * tilesHigh * GEMINI_IMAGE_TOKENS_PER_TILE;
}

function estimateImageTokens(
  block: Extract<ContentBlock, { type: "image" }>,
  options?: TokenEstimatorOptions,
): number {
  const dims = parseImageDimensions(block.source);
  if (dims) {
    if (options?.providerName === "gemini") {
      return estimateGeminiImageTokens(dims.width, dims.height);
    }
    return estimateImageTokensByDimensions(dims.width, dims.height);
  }
  // Dimensions unparseable (corrupt header, or formats parseImageDimensions
  // doesn't recognize like HEIC/HEIF coming from iOS attachments). Fall back
  // to the per-provider per-image ceiling rather than the raw base64 length,
  // which over-counts by 30-100x. Gemini's tile pricing tops out well above
  // the universal 1,600-token cap, so use its max-tile budget instead to
  // avoid under-counting large iPhone screenshots.
  if (options?.providerName === "gemini") {
    return GEMINI_IMAGE_MAX_TOKENS;
  }
  return IMAGE_MAX_TOKENS;
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
          } else if (cb.type === "file") {
            // Audio file sub-blocks (e.g. file_read on an .mp3) are sent inline
            // to Gemini; estimateFileDataTokens charges the ~32 tok/sec audio
            // rate for Gemini and ~0 for providers that drop the block.
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

/**
 * Raw (uncorrected) prompt-token estimate — exposed so the calibrator
 * can record (raw, actual) pairs. Applying calibration to the estimate
 * it uses for training would create a feedback loop that eventually
 * drives the correction ratio back to 1.0 regardless of true bias.
 */
export function estimatePromptTokensRaw(
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

export function estimatePromptTokens(
  messages: Message[],
  systemPrompt?: string,
  options?: TokenEstimatorOptions,
): number {
  const raw = estimatePromptTokensRaw(messages, systemPrompt, options);

  // Apply the self-calibration correction. Default is 1.0 for any
  // (provider, model) pair we haven't recorded a sample for, so first-call
  // behavior is unchanged. As usage data accumulates, the correction ratio
  // pulls estimates toward the provider's ground-truth token count. Lookup
  // uses the per-provider aggregate key — `getCorrection` falls back to
  // `(provider, "")` when a model-specific sample is not available.
  const providerName = options?.providerName ?? "";
  const correction = getCorrection(providerName, "");
  return correction === 1.0 ? raw : Math.ceil(raw * correction);
}

/**
 * Calibrated prompt-token estimate including the tool-definition budget.
 *
 * Combines the per-tool budget ({@link estimateToolsTokens}) with the
 * message/system estimate ({@link estimatePromptTokens}) under the EWMA
 * calibration correction. This is the estimate the overflow gate consumes;
 * the pre-send calibration capture in `agent/loop.ts` deliberately stays on
 * `estimatePromptTokensRaw` so the calibrator trains against the uncorrected
 * value rather than chasing its own output.
 */
export function estimatePromptTokensWithTools(
  history: Message[],
  systemPrompt: string | undefined,
  tools: ToolDefinition[],
  providerName: string,
): number {
  const toolTokenBudget = tools.length > 0 ? estimateToolsTokens(tools) : 0;
  return estimatePromptTokens(history, systemPrompt, {
    providerName,
    toolTokenBudget,
  });
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "<unserializable />";
  }
}

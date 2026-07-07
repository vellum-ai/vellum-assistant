import type { ToolDefinition } from "../tools/tool-types.js";
export type { ToolDefinition };

import type { LLMCallSite } from "../config/schemas/llm.js";
import { ProviderError } from "../util/errors.js";

export interface TextContent {
  type: "text";
  text: string;
}

/**
 * Base64-inline media source: the bytes travel with the block. This is the
 * runtime shape the provider transforms consume, and the shape produced for a
 * live (in-flight) turn.
 */
export interface Base64MediaSource {
  type: "base64";
  media_type: string;
  data: string;
}

/**
 * Reference media source: the bytes live in the workspace attachment store,
 * addressed by `attachmentId`. This is the shape PERSISTED into
 * `messages.content` — it keeps base64 blobs out of the DB row (and out of the
 * lexical index). It is resolved back into a {@link Base64MediaSource} at the
 * provider send boundary (see `providers/media-resolve.ts`) so the model always
 * receives inline bytes; consumers that need raw bytes out of stored content
 * (e.g. `extractMediaBlocks`) resolve it via `getAttachmentContent`.
 *
 * `sizeBytes` (and, for images, `width`/`height`) are captured at persist time
 * so size-only consumers — chiefly the per-turn token estimator — can cost the
 * block without reading the file back off disk.
 */
export interface AttachmentRefMediaSource {
  type: "attachment_ref";
  media_type: string;
  /** Attachment row id; resolve to bytes via `getAttachmentContent`. */
  attachmentId: string;
  /** Byte length of the referenced file. */
  sizeBytes: number;
  /** Decoded pixel width, when the reference is an image. */
  width?: number;
  /** Decoded pixel height, when the reference is an image. */
  height?: number;
}

export type MediaSource = Base64MediaSource | AttachmentRefMediaSource;

export interface ImageContent {
  type: "image";
  source: MediaSource;
}

export interface FileContent {
  type: "file";
  source:
    | (Base64MediaSource & { filename: string })
    | (AttachmentRefMediaSource & { filename: string });
  extracted_text?: string;
  /**
   * Internal id linking this block to a row in the attachments table.
   * Set when the file block originates from a persisted user-message
   * attachment so downstream consumers (DB joins, inline-chip
   * positioning) can correlate the block back to its attachment id.
   * Stripped by `daemon/handlers/shared.ts` before sending to the
   * model.
   */
  _attachmentId?: string;
}

export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  providerMetadata?: {
    gemini?: {
      thoughtSignature?: string;
    };
  };
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface RedactedThinkingContent {
  type: "redacted_thinking";
  data: string;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  /** Rich content blocks (e.g. images) to include alongside text in the tool result. */
  contentBlocks?: ContentBlock[];
}

export interface ServerToolUseContent {
  type: "server_tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface WebSearchToolResultContent {
  type: "web_search_tool_result";
  tool_use_id: string;
  content: unknown; // Opaque — encrypted_content in search results is provider-specific
}

export type ContentBlock =
  | TextContent
  | ThinkingContent
  | RedactedThinkingContent
  | ImageContent
  | FileContent
  | ToolUseContent
  | ToolResultContent
  | ServerToolUseContent
  | WebSearchToolResultContent;

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export type ModelIntent =
  | "balanced"
  | "latency-optimized"
  | "quality-optimized"
  | "vision-optimized";

export interface ProviderResponse {
  content: ContentBlock[];
  model: string;
  /** Provider that actually produced this response, which may differ from a wrapper provider name. */
  actualProvider?: string;
  usage: {
    /** Total input tokens (input_tokens + cache_creation + cache_read). */
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    reasoningTokens?: number;
  };
  stopReason: string;
  /** Raw JSON request body sent to the provider (for diagnostics logging). */
  rawRequest?: unknown;
  /** Raw JSON response body received from the provider (for diagnostics logging). */
  rawResponse?: unknown;
}

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_use_preview_start"; toolUseId: string; toolName: string }
  | {
      type: "input_json_delta";
      toolName: string;
      toolUseId: string;
      accumulatedJson: string;
    }
  | {
      type: "server_tool_start";
      name: string;
      toolUseId: string;
      input: Record<string, unknown>;
    }
  | {
      type: "server_tool_complete";
      toolUseId: string;
      isError: boolean;
      content?: unknown[];
      /**
       * Finalized input for the server tool call (e.g. the actual query).
       * Anthropic streams `server_tool_use` block input via `input_json_delta`
       * events, so consumers reading the input at `server_tool_start` see `{}`.
       * The provider accumulates the JSON and surfaces it here once the block
       * stops, so downstream handlers can build accurate activity metadata.
       */
      resolvedInput?: Record<string, unknown>;
      /**
       * Provider-specific error code when `isError` is true (e.g. Anthropic's
       * `max_uses_exceeded`, `query_too_long`). Surfaced so user-facing
       * messages can be specific instead of a generic "Search failed".
       */
      errorCode?: string;
      /** Optional human-readable error message from the provider. */
      errorMessage?: string;
    };

export interface SendMessageConfig {
  model?: string;
  /**
   * LLM call-site identifier. `RetryProvider` resolves
   * provider/model/maxTokens/effort/speed/verbosity/temperature/thinking/
   * contextWindow via `resolveCallSiteConfig(callSite, config.llm)`, falling
   * back to `llm.default` when no callSite-specific entry is present.
   */
  callSite?: LLMCallSite;
  /**
   * Optional ad-hoc profile override applied per request. When set, the
   * resolver layers `llm.profiles[overrideProfile]` between the workspace's
   * `activeProfile` and the call-site's named profile (see
   * `resolveCallSiteConfig`). Used by per-conversation pinned profiles to
   * override the workspace default for a single send. Missing profile names
   * silently fall through.
   */
  overrideProfile?: string;
  /**
   * When true, the resolver floats `overrideProfile` above the call-site
   * layers (named site profile + call-site override) for non-main-agent call
   * sites — see `ResolveCallSiteOpts.forceOverrideProfile`. Used by callers
   * that must run a background call site under a specific conversation's
   * inference profile (e.g. fork-based memory retrospectives). A
   * resolution/routing-time concern only; stripped before any provider wire
   * request.
   */
  forceOverrideProfile?: boolean;
  /**
   * Per-conversation seed for deterministic `mix`-profile expansion. The agent
   * loop sets this to the conversation id so every resolver call this send
   * triggers — provider/transport selection, wire-param normalization, usage
   * attribution — picks the same mix constituent, stable across the
   * conversation's turns and retries. A resolution/routing-time concern only;
   * stripped before any provider wire request.
   */
  selectionSeed?: string;
  /**
   * Internal per-request HTTP headers for managed-proxy usage attribution.
   * Provider clients may pass these through SDK request options only when the
   * transport is Vellum-managed, and must never include this object in provider
   * JSON request bodies.
   */
  usageAttributionHeaders?: Record<string, string>;
  /**
   * Controls local usage-ledger writes for attributed provider calls.
   * Defaults to `auto`; conversation paths that aggregate usage separately
   * set `manual` to avoid double-counting.
   */
  usageTracking?: "auto" | "manual";
  effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  speed?: "standard" | "fast";
  verbosity?: "low" | "medium" | "high";
  /**
   * Wire-format `logit_bias` map (`{ "<tokenId>": bias }`). Set by
   * `RetryProvider` from a profile's `logitBias` preset and forwarded only on
   * the OpenAI-compatible (Fireworks) path; other providers ignore it.
   */
  logit_bias?: Record<string, number>;
  /**
   * When true, the most recent user message's content varies across
   * otherwise-identical turns (e.g. a per-turn memory block was injected into
   * it). The provider places the primary long-TTL cache breakpoint on the most
   * recent *stable* user message instead of the volatile latest one, so the
   * cached prefix stays reusable across turns. Default false — existing
   * behavior.
   */
  mutableLatestUserMessage?: boolean;
  /**
   * When true, the provider sends no prompt-cache breakpoints at all (and
   * strips any block-level `cache_control` markers callers stamped on
   * messages). For one-shot call sites whose prompts are unique per call or
   * whose call cadence exceeds the cache TTL, every breakpoint is a paid
   * cache write that will never be read — opting out saves the write
   * premium. Resolved per call site via `resolveCallSiteConfig` (see
   * `disableCache` in the LLM config schema); a per-call explicit value
   * wins. Default false — existing behavior.
   */
  disableCache?: boolean;
  [key: string]: unknown;
}

export interface SendMessageOptions {
  tools?: ToolDefinition[];
  systemPrompt?: string;
  config?: SendMessageConfig;
  onEvent?: (event: ProviderEvent) => void;
  signal?: AbortSignal;
}

export interface Provider {
  name: string;
  /**
   * Provider key used by the local token estimator to select model-family
   * specific rules (e.g. Anthropic's `width * height / 750` image sizing).
   * Wrapper providers that route to another provider's API — e.g. OpenRouter
   * calling Anthropic's Messages endpoint for `anthropic/*` models — override
   * this so the estimator matches what the upstream API will actually charge.
   * Falls back to `name` when unset.
   */
  tokenEstimationProvider?: string;
  /**
   * True when this provider instance was constructed to run web search
   * server-side (provider-native). The native search only activates when a
   * `web_search`-named tool is passed in the request, so callers that want to
   * enable web search on a one-shot completion (e.g. the advisor consult) check
   * this first — passing the tool to a non-native instance would surface an
   * unexecutable client tool call. Absent/false on providers without it.
   */
  supportsNativeWebSearch?: boolean;
  /**
   * Per-call native web-search capability for the provider/model this specific
   * request will route to. Unlike the static {@link supportsNativeWebSearch}
   * flag — fixed to the DEFAULT provider/model at construction — this consults
   * the resolved call-site (`options.config.callSite` + `overrideProfile`) so a
   * routing wrapper reports the ROUTED target's capability. Callers that gate a
   * `web_search` server tool on a possibly-routed call (e.g. the advisor
   * consult, whose `advisorProfile` may point at a different provider/model)
   * must use this rather than the construction-time snapshot. Optional: wrappers
   * forward it to their inner provider; leaf providers may omit it, in which
   * case callers fall back to {@link supportsNativeWebSearch}.
   */
  supportsNativeWebSearchFor?(options?: SendMessageOptions): boolean;
  sendMessage(
    messages: Message[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse>;
  /**
   * Exact prompt-token count from the provider's own tokenizer, for the
   * `messages` + `systemPrompt` + `tools` composition the next call would
   * send. Optional: providers without a token-counting endpoint omit it, and
   * callers must fall back to the local estimator (`estimatePromptTokens`).
   *
   * This runs a dedicated counting request (no inference), so it carries a
   * network round-trip and the provider's own rate limit — use it for
   * user-initiated, occasional actions (e.g. `/compact`), never on the
   * per-turn hot path.
   */
  countInputTokens?(
    messages: Message[],
    systemPrompt: string,
    tools?: ToolDefinition[],
  ): Promise<number>;
}

// ── Context-overflow error ────────────────────────────────────────────

export interface ContextOverflowErrorOptions {
  /** Actual tokens the request was estimated/measured to consume, when the provider reports it. */
  actualTokens?: number;
  /** Context-window cap the provider enforced, when reported in the error body. */
  maxTokens?: number;
  /** HTTP status reported by the provider. Defaults to 400. */
  statusCode?: number;
  /** Underlying error to preserve the cause chain (standard Error.cause). */
  cause?: unknown;
}

/**
 * Thrown by provider clients when the request exceeded the model's context
 * window (HTTP 400 `context_length_exceeded`, Anthropic's `prompt_too_long`,
 * Gemini's resource-exhausted category, etc.).
 *
 * Extends `ProviderError` so existing `instanceof ProviderError` classifiers
 * (`util/retry.ts`, `daemon/conversation-error.ts`) continue to see it as a
 * typed 4xx provider error and apply the right policy. The
 * `actualTokens`/`maxTokens` fields carry structured counts when the
 * provider reports them, avoiding brittle regex parsing at the caller.
 *
 * A regex-on-message fallback still exists in
 * `daemon/parse-actual-tokens-from-error.ts` as a safety net for adapters
 * that rewrap the error (e.g. managed-proxy) before it reaches the agent
 * loop.
 */
export class ContextOverflowError extends ProviderError {
  public readonly actualTokens?: number;
  public readonly maxTokens?: number;

  constructor(
    message: string,
    provider: string,
    options: ContextOverflowErrorOptions = {},
  ) {
    super(
      message,
      provider,
      options.statusCode ?? 400,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "ContextOverflowError";
    this.actualTokens = options.actualTokens;
    this.maxTokens = options.maxTokens;
  }
}

export function isContextOverflowError(
  err: unknown,
): err is ContextOverflowError {
  return err instanceof ContextOverflowError;
}

/**
 * Extract `actualTokens` / `maxTokens` from provider overflow messages of the
 * form "N tokens > M maximum" or bare "N > M". Returns an empty object when
 * neither count is parseable — callers should treat this as "matched the
 * overflow signal but counts unknown".
 */
export function extractOverflowTokensFromMessage(message: string): {
  actualTokens?: number;
  maxTokens?: number;
} {
  const match = message.match(/(\d[\d,]*)\s*(?:tokens?\s*)?[>≥]\s*(\d[\d,]*)/i);
  if (!match) return {};
  const actual = parseInt(match[1].replace(/,/g, ""), 10);
  const max = parseInt(match[2].replace(/,/g, ""), 10);
  const out: { actualTokens?: number; maxTokens?: number } = {};
  if (!isNaN(actual) && actual > 0) out.actualTokens = actual;
  if (!isNaN(max) && max > 0) out.maxTokens = max;
  return out;
}

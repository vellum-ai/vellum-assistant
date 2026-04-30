import type { ToolDefinition } from "@vellumai/skill-host-contracts";
export type { ToolDefinition };

import type { LLMCallSite } from "../config/schemas/llm.js";
import { ProviderError } from "../util/errors.js";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface FileContent {
  type: "file";
  source: {
    type: "base64";
    media_type: string;
    data: string;
    filename: string;
  };
  extracted_text?: string;
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
  [key: string]: unknown;
}

export interface SendMessageOptions {
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
  sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse>;
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

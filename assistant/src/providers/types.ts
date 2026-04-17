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

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: object;
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
  modelIntent?: ModelIntent;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  speed?: "standard" | "fast";
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

/**
 * Brand discriminator used by `isContextOverflowError()` to recognise
 * `ContextOverflowError` instances across module-boundary / realm-boundary
 * cases where `instanceof` is unreliable (e.g. two separately-loaded copies
 * of this module in the same process). The symbol-like literal is stable
 * and unique enough to serve as a cross-realm "nominal" marker.
 */
const CONTEXT_OVERFLOW_BRAND = "context-overflow" as const;

export interface ContextOverflowErrorOptions {
  /** Actual tokens the request was estimated/measured to consume, when the provider reports it. */
  actualTokens?: number;
  /** Context-window cap the provider enforced, when reported in the error body. */
  maxTokens?: number;
  /** Raw upstream error / body for diagnostics. */
  raw: unknown;
  /** Optional underlying error to preserve the cause chain. */
  cause?: unknown;
}

/**
 * Thrown by provider clients when the request exceeded the model's context
 * window (HTTP 400 `context_length_exceeded`, Anthropic's `prompt_too_long`,
 * Gemini's resource-exhausted category, etc.).
 *
 * Prefer this typed error over string-matching on a generic `ProviderError`
 * message — the typed path carries `actualTokens` / `maxTokens` when the
 * provider surfaces them, and avoids brittle regex parsing in the caller.
 * A regex-on-message fallback still exists in
 * `daemon/parse-actual-tokens-from-error.ts` as a safety net for adapters
 * that rewrap the error before it reaches the agent loop.
 */
export class ContextOverflowError extends Error {
  /** Nominal brand for cross-realm `isContextOverflowError` checks. */
  public readonly __brand: typeof CONTEXT_OVERFLOW_BRAND =
    CONTEXT_OVERFLOW_BRAND;
  public readonly actualTokens?: number;
  public readonly maxTokens?: number;
  public readonly providerName: string;
  public readonly raw: unknown;

  constructor(
    message: string,
    providerName: string,
    options: ContextOverflowErrorOptions,
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = "ContextOverflowError";
    this.providerName = providerName;
    this.actualTokens = options.actualTokens;
    this.maxTokens = options.maxTokens;
    this.raw = options.raw;
  }
}

/**
 * Type guard that returns `true` for `ContextOverflowError` instances even
 * when `instanceof` would fail (e.g. when two separately-loaded copies of
 * this module exist in the same process). Checks both `instanceof` and the
 * `__brand` discriminator so it is robust to cross-realm / cross-copy cases.
 */
export function isContextOverflowError(
  err: unknown,
): err is ContextOverflowError {
  if (err instanceof ContextOverflowError) return true;
  if (err == null || typeof err !== "object") return false;
  const brand = (err as { __brand?: unknown }).__brand;
  if (brand !== CONTEXT_OVERFLOW_BRAND) return false;
  const name = (err as { name?: unknown }).name;
  // Name check guards against an unrelated object happening to carry the
  // same literal value on an unrelated `__brand` property.
  return name === "ContextOverflowError";
}

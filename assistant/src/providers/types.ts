import type { ToolDefinition } from "../tools/tool-types.js";
export type { ToolDefinition };

/**
 * The tool name that activates provider-native web search. Callers append a
 * tool under this name only to instances reporting
 * {@link Provider.supportsNativeWebSearch}; anywhere a request can change
 * routes after that decision (see `RetryProvider`'s backup-profile
 * escalation), the tool has to be dropped again when the new route cannot
 * serve it, or the model answers with a tool call nothing can execute.
 */
export const NATIVE_WEB_SEARCH_TOOL_NAME = "web_search";

import type { LLMCallSite } from "../config/schemas/llm.js";
import {
  ProviderError,
  type ProviderErrorReason,
  type ProviderRouteAttribution,
} from "../util/errors.js";

export interface TextContent {
  type: "text";
  text: string;
}

/**
 * Media payload for an image or file content block. One unified type covers
 * both blocks and both storage forms:
 *
 * - `base64` — the bytes travel inline with the block. This is the runtime
 *   shape the provider transforms consume and the shape produced for a live
 *   (in-flight) turn.
 * - `workspace_ref` — the bytes live somewhere in the workspace, not inline.
 *   This is the shape PERSISTED into `messages.content`, keeping large blobs
 *   out of the DB row and the lexical index. It is resolved back to inline
 *   bytes at the provider send boundary (`providers/media-resolve.ts`); any
 *   consumer that needs the raw bytes from stored content resolves it with
 *   `resolveMediaSourceData(source)`.
 *
 * `filename` is optional on both arms (present for file blocks and for
 * generated-media references). For references, `sizeBytes` (and, for images,
 * `width`/`height`) are captured at persist time so size-only consumers — the
 * per-turn token estimator especially — can cost the block without reading the
 * file back off disk.
 */
export interface Base64MediaSource {
  type: "base64";
  media_type: string;
  data: string;
  filename?: string;
}

/**
 * A reference to bytes stored in the workspace rather than inlined. The bytes
 * live in the workspace attachment store, addressed by `attachmentId`, and are
 * read back at the provider send boundary. User uploads are attachment rows
 * already; tool-result media is materialized into attachment rows before it is
 * referenced, so a single `attachmentId` resolves every case and needs no
 * fallback locator.
 *
 * `sizeBytes` (and, for images, `width`/`height`) are the persist-time hints
 * that let size-only consumers cost the block without a disk read.
 */
export interface WorkspaceRefMediaSource {
  type: "workspace_ref";
  media_type: string;
  /** Attachment row id; resolves to bytes via the attachment store. */
  attachmentId: string;
  /** Byte length of the referenced file. */
  sizeBytes: number;
  filename?: string;
  /** Decoded pixel width, when the reference is an image. */
  width?: number;
  /** Decoded pixel height, when the reference is an image. */
  height?: number;
}

export type MediaSource = Base64MediaSource | WorkspaceRefMediaSource;

export interface ImageContent {
  type: "image";
  source: MediaSource;
}

export interface FileContent {
  type: "file";
  source: MediaSource;
  extracted_text?: string;
  /**
   * Internal id linking a base64 file block to a row in the attachments table
   * so consumers (DB joins, inline-chip positioning) can correlate the block
   * back to its attachment. Redundant once the block is a reference (use
   * `source.attachmentId`); retained only while file media is still persisted
   * inline as base64, and removed when file uploads move to references.
   * Stripped by `daemon/handlers/shared.ts` before sending to the model.
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

/**
 * A client-rendered UI card persisted into conversation history: call
 * summaries, guardian approval cards, skill cards, wake notices, document
 * previews.
 *
 * This is a rendering instruction, not model context — providers drop it when
 * serializing history. Producers therefore pair the surface with a sibling
 * `text` block flagged `_surfaceFallback` (see
 * `notifications/approval-card-builder.ts`); that text is what feeds the model,
 * search indexing, CLI display, and channel replies.
 *
 * `data` is deliberately opaque: its concrete shape is selected by
 * `surfaceType` and owned by `daemon/message-types/surfaces.ts`.
 */
export interface UiSurfaceContent {
  type: "ui_surface";
  surfaceId: string;
  surfaceType: string;
  title?: string;
  data?: Record<string, unknown>;
  actions?: unknown[];
  /**
   * Free-form, matching `CurrentTurnSurface.display` — NOT the `inline` /
   * `panel` enum of the `ui_surface_show` wire event. Persisted surfaces carry
   * whatever the `ui_show` tool wrote, so this must not narrow.
   */
  display?: string;
  completed?: boolean;
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
  | WebSearchToolResultContent
  | UiSurfaceContent;

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export type ModelIntent =
  | "balanced"
  | "cost-optimized"
  | "latency-optimized"
  | "quality-optimized"
  | "vision-optimized";

export interface ProviderResponse {
  content: ContentBlock[];
  model: string;
  /** Provider that actually produced this response, which may differ from a wrapper provider name. */
  actualProvider?: string;
  /**
   * Inference profile key that actually governed this response when a
   * wrapper re-routed the request away from the caller's own resolution
   * (`RetryProvider`'s fallback-route escalation). `UsageTrackingProvider`
   * prefers this over re-resolving from the original request options, so a
   * successful fallback serve is attributed to the backup profile rather
   * than the failed primary's. Absent on the normal (non-rerouted) path.
   */
  actualInferenceProfile?: string;
  /**
   * Base URL the provider's HTTP client actually resolved to for this request,
   * read from the live SDK client instance rather than re-derived from config.
   * Lets diagnostics observe the true routing target (e.g. a misrouted host)
   * instead of inferring it. Absent for providers that don't surface it.
   */
  resolvedEndpoint?: string;
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
   * back to the shipped call-site defaults when no callSite-specific entry
   * is present.
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
   * True when the caller appended {@link NATIVE_WEB_SEARCH_TOOL_NAME} purely
   * to activate the route's provider-native web search, rather than passing an
   * app-executed search tool of the same name (which is what runs when a
   * search backend like Brave or the platform search proxy is configured).
   * Only the caller can tell those apart, and a route change after that
   * decision has to: `RetryProvider` drops the tool on a backup that runs no
   * native search, and must not touch it when the daemon executes it itself.
   * A resolution/routing-time concern only; stripped before any provider wire
   * request.
   */
  nativeWebSearchSentinel?: boolean;
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
   * Id of the user conversation that causally triggered this call, stamped by
   * call sites so `UsageTrackingProvider` can attribute the usage-ledger event
   * to the conversation (and, at flush time, its turn). A resolution/routing-
   * time concern only; stripped before any provider wire request.
   */
  conversationId?: string;
  /**
   * Per-conversation prompt-cache key for providers with explicit prompt
   * caching (sent as the OpenAI `prompt_cache_key` request param). Set by
   * `RetryProvider` from `selectionSeed` (the durable conversation id) for
   * the `openai` and `openrouter` providers — GPT-5.6+ requires the key for
   * reliable breakpoint matching, and OpenAI's ~15 req/min-per-key routing
   * guidance is satisfied by per-conversation ids. A non-wire field for
   * every other provider client (the Anthropic client strips it, covering
   * OpenRouter's `anthropic/*` delegation); the request param is omitted
   * when absent.
   */
  promptCacheKey?: string;
  /**
   * Internal per-request HTTP headers for managed-proxy usage attribution.
   * Provider clients may pass these through SDK request options only when the
   * transport is Vellum-managed, and must never include this object in provider
   * JSON request bodies.
   */
  usageAttributionHeaders?: Record<string, string>;
  /**
   * Per-request HTTP headers merged onto the transport. `RetryProvider`
   * stamps these for providers that need support-lookup headers (OpenCode
   * `x-opencode-session` / `x-opencode-request`). Provider clients pass
   * them through SDK request options only and must never include this
   * object in provider JSON request bodies.
   */
  requestHeaders?: Record<string, string>;
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
   * When true, the TURN-STARTING user message carries content that will not
   * recur byte-identically on the next turn, so a long-TTL breakpoint placed
   * on it could never be read back across turns. The agent loop is the only
   * producer: it sets the flag from the history it is about to send, when the
   * turn-starting message carries a memory-v3 `<memory_spotlight>` block (the
   * one injected block strip-and-replaced from every user message each turn).
   *
   * The flag describes the turn, not the request, so it holds for every
   * request the turn makes, including tool-loop iterations, whose trailing
   * tool-result message is user-role but carries no injected blocks.
   *
   * Consumed by the Anthropic client only, where it selects the TTL of the
   * turn-start breakpoint: short instead of long. The block is still marked,
   * so the turn's tool-loop iterations read the prefix back and each hit
   * refreshes the entry; nothing is spent on a long-TTL entry whose bytes
   * change before the next turn could reach it. Holding the flag steady across
   * the turn is what keeps that one boundary on a single TTL; marking it at
   * two would bill two writes for one reusable prefix.
   *
   * The OpenAI Responses transport ignores the flag and marks every markable
   * user item: a volatile message is fixed within its own turn, so the write is
   * prepaid once and read back by each tool-loop iteration.
   *
   * Default false. Providers that place no message-level breakpoints, or that
   * key their cache on a request-level identifier rather than message bytes,
   * can ignore it.
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
  /** Connection route whose credentials this provider instance uses. */
  routeAttribution?: ProviderRouteAttribution;
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
   * Model id this instance dispatches when a call carries no per-call model
   * override. Consumed by the local token estimator for model-keyed rules
   * (e.g. audio-capable OpenAI-compatible models). Optional: providers whose
   * estimation rules are provider-wide need not expose it.
   */
  defaultModel?: string;
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
  /** Semantic reason override; defaults to `context_overflow`. */
  reason?: ProviderErrorReason;
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
    super(message, provider, options.statusCode ?? 400, {
      reason: options.reason ?? "context_overflow",
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
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
  if (!match) {
    return {};
  }
  const actual = parseInt(match[1].replace(/,/g, ""), 10);
  const max = parseInt(match[2].replace(/,/g, ""), 10);
  const out: { actualTokens?: number; maxTokens?: number } = {};
  if (!isNaN(actual) && actual > 0) {
    out.actualTokens = actual;
  }
  if (!isNaN(max) && max > 0) {
    out.maxTokens = max;
  }
  return out;
}

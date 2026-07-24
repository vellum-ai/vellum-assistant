import { AnthropicProvider } from "../anthropic/client.js";
import {
  isAnthropicModel,
  retagDelegateError,
  toAnthropicMessagesBaseURL,
} from "../anthropic-gateway-shared.js";
import {
  modelEffortCeilings,
  modelOpenrouterPreferredUpstreams,
  PROMPT_CACHE_BREAKPOINT_MODEL_IDS,
} from "../model-catalog.js";
import {
  clampReasoningEffort,
  EFFORT_TO_REASONING_EFFORT,
  OpenAIChatCompletionsProvider,
} from "../openai/chat-completions-provider.js";
import {
  OpenAIResponsesProvider,
  type OpenAIResponsesProviderOptions,
} from "../openai/responses-provider.js";
import { isThinkingConfigEnabled } from "../thinking-config.js";
import type {
  Message,
  ProviderResponse,
  SendMessageOptions,
} from "../types.js";

export interface OpenRouterProviderOptions {
  baseURL?: string;
  streamTimeoutMs?: number;
  useNativeWebSearch?: boolean;
}

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_APP_ATTRIBUTION_HEADERS = {
  "HTTP-Referer": "https://www.vellum.ai",
  "X-OpenRouter-Title": "Vellum Assistant",
  "X-OpenRouter-Categories": "personal-agent,cli-agent",
};

const OPENROUTER_MODEL_EFFORT_CEILINGS = modelEffortCeilings("openrouter");
const OPENROUTER_MODEL_PREFERRED_UPSTREAMS =
  modelOpenrouterPreferredUpstreams("openrouter");

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
}

/**
 * Extract the normalized `openrouter.only` list from a per-call config. Returns
 * an empty array when the field is absent, empty, or contains no usable string
 * entries, so callers can branch on `length > 0` to decide whether to emit the
 * wire-format `provider: { only: [...] }` field. Exported for tests.
 */
export function extractOnlyList(config: unknown): string[] {
  const cfg = config as { openrouter?: { only?: unknown } } | undefined;
  return normalizeStringList(cfg?.openrouter?.only);
}

/**
 * Extract the normalized `openrouter.order` list — the upstream providers to
 * try first — from a per-call config. Empty when absent or malformed. Exported
 * for tests.
 */
export function extractOrderList(config: unknown): string[] {
  const cfg = config as { openrouter?: { order?: unknown } } | undefined;
  return normalizeStringList(cfg?.openrouter?.order);
}

/**
 * Extract the `openrouter.allowFallbacks` toggle from a per-call config, or
 * `undefined` when unset. Serialized as OpenRouter's snake_case
 * `allow_fallbacks` on the wire. Exported for tests.
 */
export function extractAllowFallbacks(config: unknown): boolean | undefined {
  const cfg = config as
    | { openrouter?: { allowFallbacks?: unknown } }
    | undefined;
  const allow = cfg?.openrouter?.allowFallbacks;
  return typeof allow === "boolean" ? allow : undefined;
}

/** Resolve the effective model for a call, honoring a per-call `model` override. */
export function resolveOpenRouterEffectiveModel(
  config: unknown,
  fallbackModel: string,
): string {
  const cfg = config as { model?: unknown } | undefined;
  const override =
    typeof cfg?.model === "string" && cfg.model.trim().length > 0
      ? cfg.model.trim()
      : undefined;
  return override ?? fallbackModel;
}

/**
 * Build OpenRouter's `provider` routing body object from a per-call config and
 * the effective model. Composes any caller-set `provider` fields with
 * `openrouter.only` (upstream allowlist), `openrouter.order` (upstream
 * preference — defaulting from the model catalog's `openrouterPreferredUpstreams`
 * when the config sets none), and `openrouter.allowFallbacks` (serialized as
 * OpenRouter's snake_case `allow_fallbacks`). Config-set values always win over
 * catalog defaults. Returns `undefined` when nothing applies so callers can omit
 * the field entirely. Exported for tests.
 */
export function buildOpenRouterProviderField(
  config: unknown,
  effectiveModel: string,
): Record<string, unknown> | undefined {
  const only = extractOnlyList(config);
  const configOrder = extractOrderList(config);
  const allowFallbacks = extractAllowFallbacks(config);
  const order =
    configOrder.length > 0
      ? configOrder
      : [...(OPENROUTER_MODEL_PREFERRED_UPSTREAMS.get(effectiveModel) ?? [])];

  const existingProvider = ((config as Record<string, unknown> | undefined)
    ?.provider ?? {}) as Record<string, unknown>;
  const provider: Record<string, unknown> = { ...existingProvider };
  let hasField = Object.keys(existingProvider).length > 0;
  if (only.length > 0) {
    provider.only = only;
    hasField = true;
  }
  if (order.length > 0) {
    provider.order = order;
    hasField = true;
  }
  if (allowFallbacks !== undefined) {
    provider.allow_fallbacks = allowFallbacks;
    hasField = true;
  }
  return hasField ? provider : undefined;
}

// OpenRouter's `reasoning.summary` field controls whether reasoning models emit
// a human-readable summary alongside (or instead of) encrypted reasoning blocks.
// Models like Kimi K2.6 return only encrypted `reasoning_details` unless a
// summary level is requested, so the stream carries no visible thinking content.
// Default to "detailed" so users see thinking by default; allow per-call
// override via `config.openrouter.reasoning.summary`. Per OpenRouter's
// ChatRequestReasoning schema, valid values are "auto" | "concise" | "detailed".
const VALID_REASONING_SUMMARIES = new Set(["auto", "concise", "detailed"]);

function extractReasoningSummaryOverride(config: unknown): string | undefined {
  const cfg = config as
    | { openrouter?: { reasoning?: { summary?: unknown } } }
    | undefined;
  const summary = cfg?.openrouter?.reasoning?.summary;
  return typeof summary === "string" && VALID_REASONING_SUMMARIES.has(summary)
    ? summary
    : undefined;
}

/**
 * Rewrite `options.config` for the Anthropic-compat path so OpenRouter's
 * `provider` routing body field travels through `AnthropicProvider`'s
 * `...restConfig` spread into `Anthropic.MessageStreamParams`. The `openrouter`
 * key itself is removed because Anthropic's JSON parser doesn't know about it
 * — only the translated `provider` field should reach the wire. Safe to inject
 * here because `getAnthropicInner()` hardcodes OpenRouter's baseURL; the inner
 * `AnthropicProvider` never talks to Anthropic directly. Exported for tests.
 */
export function withOpenRouterBodyExtras(
  options?: SendMessageOptions,
): SendMessageOptions | undefined {
  if (!options?.config) {
    return options;
  }
  const effectiveModel = resolveOpenRouterEffectiveModel(options.config, "");
  const provider = buildOpenRouterProviderField(options.config, effectiveModel);
  if (provider === undefined) {
    return options;
  }
  const { openrouter: _openrouter, ...rest } = options.config as Record<
    string,
    unknown
  >;
  return {
    ...options,
    config: { ...rest, provider },
  };
}

/**
 * Responses-API delegate for OpenRouter `openai/*` models with explicit
 * prompt caching. Extends the OpenAI Responses transport with OpenRouter's
 * `provider` routing body field — the same translation the chat-completions
 * path performs in `OpenRouterProvider.buildExtraCreateParams`. Exported for
 * tests.
 */
export class OpenRouterResponsesProvider extends OpenAIResponsesProvider {
  private readonly routingModel: string;

  constructor(
    apiKey: string,
    model: string,
    options: OpenAIResponsesProviderOptions = {},
  ) {
    super(apiKey, model, options);
    this.routingModel = model;
  }

  protected override buildExtraCreateParams(
    options?: SendMessageOptions,
  ): Record<string, unknown> {
    const provider = buildOpenRouterProviderField(
      options?.config,
      resolveOpenRouterEffectiveModel(options?.config, this.routingModel),
    );
    return provider === undefined ? {} : { provider };
  }
}

export class OpenRouterProvider extends OpenAIChatCompletionsProvider {
  private readonly openRouterApiKey: string;
  private readonly defaultModel: string;
  private readonly resolvedBaseURL: string;
  private readonly providerStreamTimeoutMs: number | undefined;
  private readonly useNativeWebSearch: boolean;
  private anthropicInner: AnthropicProvider | undefined;
  private responsesInner: OpenRouterResponsesProvider | undefined;

  constructor(
    apiKey: string,
    model: string,
    options: OpenRouterProviderOptions = {},
  ) {
    const baseURL = options.baseURL?.trim() || DEFAULT_OPENROUTER_BASE_URL;
    super(apiKey, model, {
      baseURL,
      providerName: "openrouter",
      providerLabel: "OpenRouter",
      streamTimeoutMs: options.streamTimeoutMs,
      requestHeaders: OPENROUTER_APP_ATTRIBUTION_HEADERS,
      assistantReasoningField: "reasoning",
      backfillEmptyAssistantContent: true,
    });
    this.openRouterApiKey = apiKey;
    this.defaultModel = model;
    this.resolvedBaseURL = baseURL;
    this.providerStreamTimeoutMs = options.streamTimeoutMs;
    this.useNativeWebSearch = options.useNativeWebSearch ?? false;
  }

  // When routing to an `anthropic/*` model, actual API calls hit the Anthropic
  // Messages endpoint, which charges for images using dimension-based pricing
  // (~width*height/750 tokens) rather than the generic `base64/4` heuristic.
  // Expose this so the local token estimator picks the matching rules and
  // `shouldCompact()` doesn't over-count image tokens by ~100×.
  get tokenEstimationProvider(): string {
    return isAnthropicModel(this.defaultModel) ? "anthropic" : this.name;
  }

  /** See {@link Provider.supportsNativeWebSearch}. Set per model at construction. */
  get supportsNativeWebSearch(): boolean {
    return this.useNativeWebSearch;
  }

  override async sendMessage(
    messages: Message[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const effectiveModel = this.resolveEffectiveModel(options);
    try {
      if (isAnthropicModel(effectiveModel)) {
        return await this.getAnthropicInner().sendMessage(
          messages,
          withOpenRouterBodyExtras(options),
        );
      }
      // OpenRouter supports OpenAI explicit prompt caching only on its
      // Responses endpoint, so models flagged for cache breakpoints route
      // there. Native web search stays on the chat-completions path — the
      // Responses `web_search_preview` server tool is unverified through
      // OpenRouter.
      if (
        !this.useNativeWebSearch &&
        PROMPT_CACHE_BREAKPOINT_MODEL_IDS.has(effectiveModel)
      ) {
        return await this.getResponsesInner().sendMessage(messages, options);
      }
      return await super.sendMessage(messages, options);
    } catch (error) {
      retagDelegateError(error, this.name);
    }
  }

  // OpenRouter's unified `reasoning` parameter controls extended thinking on
  // its OpenAI-compatible endpoint. Anthropic models skip this path entirely and
  // go through AnthropicProvider, which receives the native `thinking` object.
  //
  // `effort` nests under `reasoning` here (rather than flat `reasoning_effort`)
  // because OpenRouter's documented `ChatRequestReasoning` shape is the union of
  // { effort, summary }. `summary` is required for models like Kimi K2.6 that
  // would otherwise return only encrypted reasoning blocks; we default to
  // "detailed" and let callers override via `config.openrouter.reasoning.summary`.
  protected override buildExtraCreateParams(
    options?: SendMessageOptions,
  ): Record<string, unknown> {
    const config = options?.config as Record<string, unknown> | undefined;
    const thinkingEnabled = isThinkingConfigEnabled(config?.thinking);
    const effort = config?.effort as string | undefined;
    const mappedEffort = effort
      ? EFFORT_TO_REASONING_EFFORT[effort]
      : undefined;
    const summaryOverride = extractReasoningSummaryOverride(config);
    // Only send `reasoning` when explicitly enabling thinking. Omitting the
    // field lets OpenRouter use the model's natural default, which avoids 400s
    // from reasoning-only models (e.g. DeepSeek R1) that reject `enabled: false`.
    const extras: Record<string, unknown> = {};
    if (thinkingEnabled) {
      const reasoning: Record<string, unknown> = { enabled: true };
      if (mappedEffort) {
        reasoning.effort = clampReasoningEffort(
          mappedEffort,
          this.resolveMaxReasoningEffort(this.resolveEffectiveModel(options)),
        );
      }
      reasoning.summary = summaryOverride ?? "detailed";
      extras.reasoning = reasoning;
    }
    const provider = buildOpenRouterProviderField(
      config,
      this.resolveEffectiveModel(options),
    );
    if (provider !== undefined) {
      extras.provider = provider;
    }
    return extras;
  }

  // Consult the catalog for a per-model effort ceiling before falling back to
  // the provider-wide default. Keeps grok-4.5 (low|medium|high only) from
  // receiving Vellum's xhigh/max efforts, which its API rejects.
  protected override resolveMaxReasoningEffort(
    model: string,
  ): "high" | "xhigh" | "max" {
    return (
      OPENROUTER_MODEL_EFFORT_CEILINGS.get(model) ??
      super.resolveMaxReasoningEffort(model)
    );
  }

  private resolveEffectiveModel(options?: SendMessageOptions): string {
    return resolveOpenRouterEffectiveModel(options?.config, this.defaultModel);
  }

  private getAnthropicInner(): AnthropicProvider {
    if (!this.anthropicInner) {
      this.anthropicInner = new AnthropicProvider(
        this.openRouterApiKey,
        this.defaultModel,
        {
          baseURL: toAnthropicMessagesBaseURL(this.resolvedBaseURL),
          streamTimeoutMs: this.providerStreamTimeoutMs,
          authToken: this.openRouterApiKey,
          useNativeWebSearch: this.useNativeWebSearch,
          requestHeaders: OPENROUTER_APP_ATTRIBUTION_HEADERS,
        },
      );
    }
    return this.anthropicInner;
  }

  private getResponsesInner(): OpenRouterResponsesProvider {
    if (!this.responsesInner) {
      this.responsesInner = new OpenRouterResponsesProvider(
        this.openRouterApiKey,
        this.defaultModel,
        {
          baseURL: this.resolvedBaseURL,
          providerName: this.name,
          providerLabel: "OpenRouter",
          streamTimeoutMs: this.providerStreamTimeoutMs,
          requestHeaders: OPENROUTER_APP_ATTRIBUTION_HEADERS,
        },
      );
    }
    return this.responsesInner;
  }
}

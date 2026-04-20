import { AnthropicProvider } from "../anthropic/client.js";
import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";
import type {
  Message,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../types.js";

export interface OpenRouterProviderOptions {
  apiKey?: string;
  baseURL?: string;
  streamTimeoutMs?: number;
  useNativeWebSearch?: boolean;
}

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// Models on OpenRouter prefixed `anthropic/` are routed through OpenRouter's
// Anthropic-compatible Messages API at `<root>/v1/messages` (where `<root>` is
// the OpenRouter API root, e.g. `https://openrouter.ai/api`) so that
// Anthropic-native features — extended thinking, prompt caching, cache TTL,
// output_config — work without lossy translation through the OpenAI chat
// completions compatibility layer. The Anthropic SDK appends `/v1/messages` to
// its configured baseURL, so we strip the trailing `/v1` segment from the
// OpenAI-compat base before handing it to the SDK.
function isAnthropicModel(model: string): boolean {
  return model.startsWith("anthropic/");
}

function toAnthropicMessagesBaseURL(openRouterBaseURL: string): string {
  return openRouterBaseURL.replace(/\/v1\/?$/, "");
}

/**
 * Extract the normalized `openrouter.only` list from a per-call config. Returns
 * an empty array when the field is absent, empty, or contains no usable string
 * entries, so callers can branch on `length > 0` to decide whether to emit the
 * wire-format `provider: { only: [...] }` field. Exported for tests.
 */
export function extractOnlyList(config: unknown): string[] {
  const cfg = config as { openrouter?: { only?: unknown } } | undefined;
  const only = cfg?.openrouter?.only;
  if (!Array.isArray(only)) return [];
  return only.filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
}

/**
 * Rewrite `options.config` for the Anthropic-compat path so OpenRouter's
 * `provider: { only: [...] }` body field travels through `AnthropicProvider`'s
 * `...restConfig` spread into `Anthropic.MessageStreamParams`. The `openrouter`
 * key itself is removed because Anthropic's JSON parser doesn't know about it
 * — only the translated `provider` field should reach the wire. Safe to inject
 * here because `getAnthropicInner()` hardcodes OpenRouter's baseURL; the inner
 * `AnthropicProvider` never talks to Anthropic directly. Exported for tests.
 */
export function withOpenRouterBodyExtras(
  options?: SendMessageOptions,
): SendMessageOptions | undefined {
  if (!options?.config) return options;
  const only = extractOnlyList(options.config);
  if (only.length === 0) return options;
  const { openrouter: _openrouter, ...rest } = options.config as Record<
    string,
    unknown
  >;
  return { ...options, config: { ...rest, provider: { only } } };
}

export class OpenRouterProvider extends OpenAIChatCompletionsProvider {
  private readonly openRouterApiKey: string;
  private readonly defaultModel: string;
  private readonly resolvedBaseURL: string;
  private readonly providerStreamTimeoutMs: number | undefined;
  private readonly useNativeWebSearch: boolean;
  private anthropicInner: AnthropicProvider | undefined;

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

  override async sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const effectiveModel = this.resolveEffectiveModel(options);
    if (isAnthropicModel(effectiveModel)) {
      return this.getAnthropicInner().sendMessage(
        messages,
        tools,
        systemPrompt,
        withOpenRouterBodyExtras(options),
      );
    }
    return super.sendMessage(messages, tools, systemPrompt, options);
  }

  // OpenRouter's unified `reasoning` parameter controls extended thinking on
  // its OpenAI-compatible endpoint. Mirror the assistant's `thinking.enabled`
  // config — loop.ts only sets `config.thinking` when enabled — so non-
  // Anthropic reasoning models (e.g. xAI Grok) can be toggled the same way.
  // Anthropic models skip this path entirely and go through AnthropicProvider.
  protected override buildExtraCreateParams(
    options?: SendMessageOptions,
  ): Record<string, unknown> {
    const config = options?.config as Record<string, unknown> | undefined;
    const thinkingEnabled = config?.thinking !== undefined;
    const extras: Record<string, unknown> = {
      reasoning: { enabled: thinkingEnabled },
    };
    const only = extractOnlyList(config);
    if (only.length > 0) {
      extras.provider = { only };
    }
    return extras;
  }

  private resolveEffectiveModel(options?: SendMessageOptions): string {
    const config = options?.config as Record<string, unknown> | undefined;
    const override =
      typeof config?.model === "string" && config.model.trim().length > 0
        ? config.model.trim()
        : undefined;
    return override ?? this.defaultModel;
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
        },
      );
    }
    return this.anthropicInner;
  }
}

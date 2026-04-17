import { AnthropicProvider } from "../anthropic/client.js";
import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";
import type {
  Message,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../types.js";
import { ContextOverflowError, isContextOverflowError } from "../types.js";

export interface OpenRouterProviderOptions {
  apiKey?: string;
  baseURL?: string;
  streamTimeoutMs?: number;
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

export class OpenRouterProvider extends OpenAIChatCompletionsProvider {
  private readonly openRouterApiKey: string;
  private readonly defaultModel: string;
  private readonly resolvedBaseURL: string;
  private readonly providerStreamTimeoutMs: number | undefined;
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
    try {
      if (isAnthropicModel(effectiveModel)) {
        return await this.getAnthropicInner().sendMessage(
          messages,
          tools,
          systemPrompt,
          options,
        );
      }
      return await super.sendMessage(messages, tools, systemPrompt, options);
    } catch (error) {
      // Re-tag delegate-thrown ContextOverflowError so the outer provider name
      // matches the configured provider ("openrouter"). This keeps downstream
      // error reporting and metrics attribution accurate, while preserving the
      // actualTokens/maxTokens extracted by the delegate.
      if (isContextOverflowError(error) && error.providerName !== this.name) {
        throw new ContextOverflowError(error.message, this.name, {
          actualTokens: error.actualTokens,
          maxTokens: error.maxTokens,
          raw: error.raw,
          cause: error,
        });
      }
      throw error;
    }
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
    return { reasoning: { enabled: thinkingEnabled } };
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
        },
      );
    }
    return this.anthropicInner;
  }
}

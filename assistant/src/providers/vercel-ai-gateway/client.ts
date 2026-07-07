import { AnthropicProvider } from "../anthropic/client.js";
import {
  isAnthropicModel,
  retagDelegateError,
  toAnthropicMessagesBaseURL,
} from "../anthropic-gateway-shared.js";
import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";
import type {
  Message,
  ProviderResponse,
  SendMessageOptions,
} from "../types.js";

export interface VercelAIGatewayProviderOptions {
  baseURL?: string;
  streamTimeoutMs?: number;
  useNativeWebSearch?: boolean;
}

const DEFAULT_VERCEL_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

export class VercelAIGatewayProvider extends OpenAIChatCompletionsProvider {
  private readonly gatewayApiKey: string;
  private readonly defaultModel: string;
  private readonly resolvedBaseURL: string;
  private readonly providerStreamTimeoutMs: number | undefined;
  private readonly useNativeWebSearch: boolean;
  private anthropicInner: AnthropicProvider | undefined;

  constructor(
    apiKey: string,
    model: string,
    options: VercelAIGatewayProviderOptions = {},
  ) {
    const baseURL =
      options.baseURL?.trim() || DEFAULT_VERCEL_AI_GATEWAY_BASE_URL;
    super(apiKey, model, {
      baseURL,
      providerName: "vercel-ai-gateway",
      providerLabel: "Vercel AI Gateway",
      streamTimeoutMs: options.streamTimeoutMs,
      // Vercel's OpenAI-compat endpoint streams reasoning text in
      // `delta.reasoning` (see its Advanced Configuration docs).
      assistantReasoningField: "reasoning",
      backfillEmptyAssistantContent: true,
    });
    this.gatewayApiKey = apiKey;
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

  // Native web search is only wired through the Anthropic Messages delegate;
  // the OpenAI-compat path has no native search tool mapping.
  get supportsNativeWebSearch(): boolean {
    return this.useNativeWebSearch && isAnthropicModel(this.defaultModel);
  }

  override async sendMessage(
    messages: Message[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const effectiveModel = this.resolveEffectiveModel(options);
    try {
      if (isAnthropicModel(effectiveModel)) {
        return await this.getAnthropicInner().sendMessage(messages, options);
      }
      return await super.sendMessage(messages, options);
    } catch (error) {
      retagDelegateError(error, this.name);
    }
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
        this.gatewayApiKey,
        this.defaultModel,
        {
          baseURL: toAnthropicMessagesBaseURL(this.resolvedBaseURL),
          streamTimeoutMs: this.providerStreamTimeoutMs,
          authToken: this.gatewayApiKey,
          useNativeWebSearch: this.useNativeWebSearch,
        },
      );
    }
    return this.anthropicInner;
  }
}

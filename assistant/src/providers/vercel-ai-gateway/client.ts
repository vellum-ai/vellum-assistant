import { ProviderError } from "../../util/errors.js";
import { AnthropicProvider } from "../anthropic/client.js";
import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";
import type {
  Message,
  ProviderResponse,
  SendMessageOptions,
} from "../types.js";
import { ContextOverflowError, isContextOverflowError } from "../types.js";

export interface VercelAIGatewayProviderOptions {
  apiKey?: string;
  baseURL?: string;
  streamTimeoutMs?: number;
  useNativeWebSearch?: boolean;
}

const DEFAULT_VERCEL_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

// Models prefixed `anthropic/` are routed through the gateway's
// Anthropic-compatible Messages API at `<root>/v1/messages` so that
// Anthropic-native features — extended thinking, prompt caching, cache TTL,
// output_config — work without lossy translation through the OpenAI chat
// completions compatibility layer. The Anthropic SDK appends `/v1/messages` to
// its configured baseURL, so we strip the trailing `/v1` segment from the
// OpenAI-compat base before handing it to the SDK.
function isAnthropicModel(model: string): boolean {
  return model.startsWith("anthropic/");
}

export function toAnthropicMessagesBaseURL(baseURL: string): string {
  return baseURL.replace(/\/v1\/?$/, "");
}

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
        return await this.getAnthropicInner().sendMessage(messages, options);
      }
      return await super.sendMessage(messages, options);
    } catch (error) {
      // Re-tag delegate-thrown ContextOverflowError so the outer provider name
      // matches the configured provider ("vercel-ai-gateway"). This keeps
      // downstream error reporting and metrics attribution accurate, while
      // preserving the actualTokens/maxTokens extracted by the delegate.
      if (isContextOverflowError(error) && error.provider !== this.name) {
        throw new ContextOverflowError(error.message, this.name, {
          actualTokens: error.actualTokens,
          maxTokens: error.maxTokens,
          statusCode: error.statusCode,
          cause: error,
        });
      }
      if (error instanceof ProviderError && error.provider !== this.name) {
        throw new ProviderError(error.message, this.name, error.statusCode, {
          cause: error.cause ?? error,
          retryAfterMs: error.retryAfterMs,
          abortReason: error.abortReason,
        });
      }
      throw error;
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

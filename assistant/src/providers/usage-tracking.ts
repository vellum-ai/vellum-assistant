import { recordUsageEvent } from "../persistence/llm-usage-store.js";
import { resolveUsageAttribution } from "../usage/attribution.js";
import {
  buildPricingUsageFromResponse,
  extractRawUsage,
  resolveStructuredPricing,
} from "../usage/pricing.js";
import { getLogger } from "../util/logger.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "./types.js";

const log = getLogger("provider-usage-tracking");

export class UsageTrackingProvider implements Provider {
  public readonly name: string;
  public readonly tokenEstimationProvider?: string;
  // Forward native web-search capability so it survives the wrapper chain
  // (callers like the advisor consult gate on it). Fixed at construction.
  public readonly supportsNativeWebSearch?: boolean;
  // Forward the optional token-counting endpoint so the capability survives
  // the wrapper chain. Bound straight to the inner provider — count_tokens is
  // not billed, so there's no usage to track.
  public readonly countInputTokens?: NonNullable<Provider["countInputTokens"]>;

  constructor(private readonly inner: Provider) {
    this.name = inner.name;
    this.tokenEstimationProvider = inner.tokenEstimationProvider;
    this.supportsNativeWebSearch = inner.supportsNativeWebSearch;
    if (inner.countInputTokens) {
      this.countInputTokens = inner.countInputTokens.bind(inner);
    }
  }

  supportsNativeWebSearchFor(options?: SendMessageOptions): boolean {
    return this.inner.supportsNativeWebSearchFor
      ? this.inner.supportsNativeWebSearchFor(options)
      : this.inner.supportsNativeWebSearch === true;
  }

  async sendMessage(
    messages: Message[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const response = await this.inner.sendMessage(messages, options);
    this.recordUsage(response, options);
    return response;
  }

  private recordUsage(
    response: ProviderResponse,
    options?: SendMessageOptions,
  ): void {
    const config = options?.config;
    if (!config?.callSite) return;
    if (config.usageTracking === "manual") return;
    if (response.usage.inputTokens <= 0 && response.usage.outputTokens <= 0) {
      return;
    }

    try {
      const attribution = resolveUsageAttribution({
        callSite: config.callSite,
        overrideProfile: config.overrideProfile,
      });
      const providerName = response.actualProvider ?? this.inner.name;
      const pricingUsage = buildPricingUsageFromResponse(
        providerName,
        response,
      );
      const pricing = resolveStructuredPricing(
        providerName,
        response.model,
        pricingUsage,
      );

      recordUsageEvent(
        {
          actor: "llm_call_site",
          provider: providerName,
          model: response.model,
          inputTokens: pricingUsage.directInputTokens,
          outputTokens: pricingUsage.outputTokens,
          cacheCreationInputTokens: pricingUsage.cacheCreationInputTokens,
          cacheReadInputTokens: pricingUsage.cacheReadInputTokens,
          rawUsage: extractRawUsage(response.rawResponse),
          conversationId: null,
          runId: null,
          requestId: null,
          callSite: attribution.callSite,
          inferenceProfile: attribution.appliedProfile,
          inferenceProfileSource: attribution.profileSource,
          llmCallCount: 1,
        },
        pricing,
      );
    } catch (err) {
      log.warn(
        { err, callSite: config.callSite },
        "Failed to auto-record provider usage event (non-fatal)",
      );
    }
  }
}

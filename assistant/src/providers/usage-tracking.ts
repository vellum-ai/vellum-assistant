import { recordUsageEvent } from "../memory/llm-usage-store.js";
import { resolveUsageAttribution } from "../usage/attribution.js";
import {
  buildPricingUsageFromResponse,
  resolveStructuredPricing,
} from "../usage/pricing.js";
import { getLogger } from "../util/logger.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "./types.js";

const log = getLogger("provider-usage-tracking");

export class UsageTrackingProvider implements Provider {
  public readonly name: string;
  public readonly tokenEstimationProvider?: string;

  constructor(private readonly inner: Provider) {
    this.name = inner.name;
    this.tokenEstimationProvider = inner.tokenEstimationProvider;
  }

  async sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const response = await this.inner.sendMessage(
      messages,
      tools,
      systemPrompt,
      options,
    );
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

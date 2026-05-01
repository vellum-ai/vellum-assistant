/**
 * Provider wrapper that routes each `sendMessage` call to a different
 * underlying provider transport when the per-call `options.config.callSite`
 * resolves to a provider name that differs from the default.
 *
 * Without this wrapper the conversation-level provider transport is fixed at
 * construction time, so a per-call-site `llm.callSites.<id>.provider`
 * override only affects the request *metadata* the downstream client sees —
 * the actual HTTP transport still belongs to `llm.default.provider`. That
 * means routing decisions like "send `memoryRetrieval` calls to OpenAI even
 * though the main agent runs on Anthropic" silently fail.
 *
 * `CallSiteRoutingProvider` consults `resolveCallSiteConfig` per call. When
 * the resolved provider name differs from the default's name and the
 * registry can produce a Provider for it, the call is delegated to that
 * provider; otherwise it falls back to the default. Other Provider interface
 * surface area (`name`, `tokenEstimationProvider`) is delegated to the
 * default so wrappers further out (e.g. `RateLimitProvider`) still see a
 * stable identity.
 */

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "./types.js";

export class CallSiteRoutingProvider implements Provider {
  public readonly name: string;
  public readonly tokenEstimationProvider?: string;

  constructor(
    private readonly defaultProvider: Provider,
    private readonly getProviderByName: (name: string) => Provider | undefined,
  ) {
    this.name = defaultProvider.name;
    this.tokenEstimationProvider = defaultProvider.tokenEstimationProvider;
  }

  async sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const target = this.selectProvider(options);
    const response = await target.sendMessage(
      messages,
      tools,
      systemPrompt,
      options,
    );
    // When routing to a non-default provider, stamp actualProvider so that
    // callers (loop.ts, emitUsage, llm_call_finished) attribute the call to
    // the right provider instead of falling back to the default provider's
    // name. Without this, a memoryRetrieval call routed to "openai" from an
    // "anthropic"-default conversation would be logged and billed as
    // "anthropic", causing wrong provider labels and $0 cost (no pricing
    // match for e.g. gpt-5.5 under the anthropic catalog).
    if (target !== this.defaultProvider && response.actualProvider == null) {
      return { ...response, actualProvider: target.name };
    }
    return response;
  }

  /**
   * Pick the provider to route this call through. The default provider wins
   * unless the per-call `callSite` (layered with any `overrideProfile`)
   * resolves to a different provider name and the registry can produce a
   * Provider for it.
   */
  private selectProvider(options?: SendMessageOptions): Provider {
    const callSite = options?.config?.callSite;
    if (!callSite) return this.defaultProvider;

    const overrideProfile = options?.config?.overrideProfile;
    const resolved = resolveCallSiteConfig(callSite, getConfig().llm, {
      overrideProfile,
    });
    if (resolved.provider === this.defaultProvider.name) {
      return this.defaultProvider;
    }

    const alternative = this.getProviderByName(resolved.provider);
    return alternative ?? this.defaultProvider;
  }
}

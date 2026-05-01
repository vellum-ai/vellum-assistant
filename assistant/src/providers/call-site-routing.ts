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

import { AsyncLocalStorage } from "node:async_hooks";

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
  public readonly tokenEstimationProvider?: string;

  // Per-call async context that tracks which provider is currently executing.
  // Using AsyncLocalStorage instead of a plain instance field means concurrent
  // sendMessage calls (e.g. the main agent turn and a title-generation call
  // both in-flight at the same time on the same provider instance) each see
  // their own value — no clobbering, no premature clear.
  //
  // During sendMessage, emitLlmCallStartedIfNeeded reads provider.name on the
  // first text_delta (before the response completes). The getter below returns
  // the async-context value so streaming trace events carry the routed
  // provider's name, not the default's.
  private readonly _activeProviderContext = new AsyncLocalStorage<string>();

  get name(): string {
    return this._activeProviderContext.getStore() ?? this.defaultProvider.name;
  }

  constructor(
    private readonly defaultProvider: Provider,
    private readonly getProviderByName: (name: string) => Provider | undefined,
  ) {
    this.tokenEstimationProvider = defaultProvider.tokenEstimationProvider;
  }

  async sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const target = this.selectProvider(options);
    const isRouted = target !== this.defaultProvider;

    const doSend = async (): Promise<ProviderResponse> => {
      const response = await target.sendMessage(
        messages,
        tools,
        systemPrompt,
        options,
      );
      // Also stamp actualProvider on the response so that handleUsage /
      // llm_call_finished (which read event.actualProvider, not provider.name)
      // attribute the call to the right provider.
      if (isRouted && response.actualProvider == null) {
        return { ...response, actualProvider: target.name };
      }
      return response;
    };

    // Run inside the async context so that any code reading provider.name
    // during streaming (e.g. emitLlmCallStartedIfNeeded on text_delta) sees
    // the routed provider's name for this specific call, not the default.
    return isRouted
      ? this._activeProviderContext.run(target.name, doSend)
      : doSend();
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

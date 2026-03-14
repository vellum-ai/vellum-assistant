import { wrapWithLogfire } from "../logfire.js";
import { getSecureKey } from "../security/secure-keys.js";
import { ConfigError, ProviderNotConfiguredError } from "../util/errors.js";
import { AnthropicProvider } from "./anthropic/client.js";
import { FailoverProvider, type ProviderHealthStatus } from "./failover.js";
import { FireworksProvider } from "./fireworks/client.js";
import { GeminiProvider } from "./gemini/client.js";
import {
  buildManagedBaseUrl,
  resolveManagedProxyContext,
} from "./managed-proxy/context.js";
import { getProviderDefaultModel } from "./model-intents.js";
import { OllamaProvider } from "./ollama/client.js";
import { OpenAIProvider } from "./openai/client.js";
import { OpenRouterProvider } from "./openrouter/client.js";
import { RetryProvider } from "./retry.js";
import type { Provider } from "./types.js";

const providers = new Map<string, Provider>();
const routingSources = new Map<string, "user-key" | "managed-proxy">();
let cachedFailoverProvider: FailoverProvider | null = null;
let cachedFailoverKey: string | null = null;

export function registerProvider(name: string, provider: Provider): void {
  providers.set(name, provider);
}

export function getProvider(name: string): Provider {
  const provider = providers.get(name);
  if (!provider) {
    throw new ConfigError(
      `Provider "${name}" not found. Available: ${listProviders().join(", ")}`,
    );
  }
  return provider;
}

export interface ProviderSelection {
  /** Ordered list of available provider names */
  availableProviders: string[];
  /** The selected (effective) primary provider name, or null if none available */
  selectedPrimary: string | null;
  /** Whether the effective primary differs from the requested primary */
  usedFallbackPrimary: boolean;
}

/**
 * Resolve provider selection from requested primary and provider order.
 * Dedupes [requestedPrimary, ...providerOrder], filtered to initialized providers.
 * Returns null selectedPrimary when no providers are available.
 */
export function resolveProviderSelection(
  requestedPrimary: string,
  providerOrder: string[],
): ProviderSelection {
  const ordered: string[] = [];
  const seen = new Set<string>();

  for (const name of [requestedPrimary, ...providerOrder]) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (providers.has(name)) {
      ordered.push(name);
    }
  }

  if (ordered.length === 0) {
    return {
      availableProviders: [],
      selectedPrimary: null,
      usedFallbackPrimary: false,
    };
  }

  return {
    availableProviders: ordered,
    selectedPrimary: ordered[0],
    usedFallbackPrimary: ordered[0] !== requestedPrimary,
  };
}

/**
 * Build a provider that tries the effective primary provider first, then falls
 * back to others in the configured order. If the requested primary is not
 * available, automatically selects the first available provider from the
 * deduped [primaryName, ...providerOrder] list (fail-open).
 *
 * Throws ConfigError only when NO providers are available at all.
 * Caches the FailoverProvider instance so health state persists across calls.
 */
export function getFailoverProvider(
  primaryName: string,
  providerOrder: string[],
): Provider {
  const selection = resolveProviderSelection(primaryName, providerOrder);

  if (!selection.selectedPrimary) {
    throw new ProviderNotConfiguredError(primaryName, listProviders());
  }

  const orderedProviders: Provider[] = selection.availableProviders.map(
    (name) => providers.get(name)!,
  );

  if (orderedProviders.length === 1) {
    return orderedProviders[0];
  }

  // Cache key from effective ordered providers (not raw input strings)
  const cacheKey = selection.availableProviders.join(",");
  if (cachedFailoverProvider && cachedFailoverKey === cacheKey) {
    return cachedFailoverProvider;
  }

  cachedFailoverProvider = new FailoverProvider(orderedProviders);
  cachedFailoverKey = cacheKey;
  return cachedFailoverProvider;
}

export function listProviders(): string[] {
  return Array.from(providers.keys());
}

export function getProviderRoutingSource(
  name: string,
): "user-key" | "managed-proxy" | undefined {
  return routingSources.get(name);
}

/**
 * Return the default model for a given provider name.
 * Falls back to the Anthropic default if the provider name is unknown.
 */
export function getDefaultModel(providerName: string): string {
  return getProviderDefaultModel(providerName);
}

export interface ProvidersConfig {
  provider: string;
  model: string;
  webSearchProvider?: string;
  timeouts?: { providerStreamTimeoutSec?: number };
}

function resolveModel(config: ProvidersConfig, providerName: string): string {
  if (config.provider === providerName) {
    // If a non-Anthropic provider is selected with the untouched global default
    // model, use a provider-appropriate fallback instead.
    if (
      providerName !== "anthropic" &&
      config.model === getProviderDefaultModel("anthropic")
    ) {
      return getProviderDefaultModel(providerName);
    }
    return config.model;
  }
  return getProviderDefaultModel(providerName);
}

export interface ProviderDebugStatus {
  configuredPrimary: string;
  activePrimary: string | null;
  usedFallback: boolean;
  registeredProviders: string[];
  failoverHealth: ProviderHealthStatus[] | null;
  overallHealth: "healthy" | "degraded" | "down";
}

export function getProviderDebugStatus(
  configuredProvider: string,
  providerOrder: string[],
): ProviderDebugStatus {
  const registered = listProviders();
  const selection = resolveProviderSelection(configuredProvider, providerOrder);

  let failoverHealth: ProviderHealthStatus[] | null = null;
  if (cachedFailoverProvider) {
    failoverHealth = cachedFailoverProvider.getHealthStatus();
  }

  let overallHealth: "healthy" | "degraded" | "down" = "down";
  if (registered.length > 0 && selection.selectedPrimary) {
    if (!failoverHealth) {
      overallHealth = "healthy";
    } else {
      const healthyCount = failoverHealth.filter((h) => h.healthy).length;
      if (healthyCount === failoverHealth.length) {
        overallHealth = "healthy";
      } else if (healthyCount > 0) {
        overallHealth = "degraded";
      }
    }
  }

  return {
    configuredPrimary: configuredProvider,
    activePrimary: selection.selectedPrimary,
    usedFallback: selection.usedFallbackPrimary,
    registeredProviders: registered,
    failoverHealth,
    overallHealth,
  };
}

export function initializeProviders(config: ProvidersConfig): void {
  providers.clear();
  routingSources.clear();
  cachedFailoverProvider = null;
  cachedFailoverKey = null;

  const streamTimeoutMs =
    (config.timeouts?.providerStreamTimeoutSec ?? 300) * 1000;

  const anthropicKey = getSecureKey("anthropic");
  if (anthropicKey) {
    const model = resolveModel(config, "anthropic");
    registerProvider(
      "anthropic",
      new RetryProvider(
        wrapWithLogfire(
          new AnthropicProvider(anthropicKey, model, {
            useNativeWebSearch: config.webSearchProvider === "anthropic-native",
            streamTimeoutMs,
          }),
        ),
      ),
    );
    routingSources.set("anthropic", "user-key");
  } else {
    // No user Anthropic key — route through managed proxy
    const managedBaseUrl = buildManagedBaseUrl("anthropic");
    if (managedBaseUrl) {
      const ctx = resolveManagedProxyContext();
      const model = resolveModel(config, "anthropic");
      registerProvider(
        "anthropic",
        new RetryProvider(
          wrapWithLogfire(
            new AnthropicProvider(ctx.assistantApiKey, model, {
              useNativeWebSearch:
                config.webSearchProvider === "anthropic-native",
              streamTimeoutMs,
              baseURL: managedBaseUrl,
            }),
          ),
        ),
      );
      routingSources.set("anthropic", "managed-proxy");
    }
  }
  const openaiKey = getSecureKey("openai");
  if (openaiKey) {
    const model = resolveModel(config, "openai");
    registerProvider(
      "openai",
      new RetryProvider(
        wrapWithLogfire(
          new OpenAIProvider(openaiKey, model, { streamTimeoutMs }),
        ),
      ),
    );
    routingSources.set("openai", "user-key");
  } else {
    const managedBaseUrl = buildManagedBaseUrl("openai");
    if (managedBaseUrl) {
      const ctx = resolveManagedProxyContext();
      const model = resolveModel(config, "openai");
      registerProvider(
        "openai",
        new RetryProvider(
          wrapWithLogfire(
            new OpenAIProvider(ctx.assistantApiKey, model, {
              baseURL: managedBaseUrl,
              streamTimeoutMs,
            }),
          ),
        ),
      );
      routingSources.set("openai", "managed-proxy");
    }
  }
  const geminiKey = getSecureKey("gemini");
  if (geminiKey) {
    const model = resolveModel(config, "gemini");
    registerProvider(
      "gemini",
      new RetryProvider(
        wrapWithLogfire(
          new GeminiProvider(geminiKey, model, { streamTimeoutMs }),
        ),
      ),
    );
    routingSources.set("gemini", "user-key");
  } else {
    // No user Gemini key — route through Vertex managed proxy
    const managedBaseUrl = buildManagedBaseUrl("vertex");
    if (managedBaseUrl) {
      const ctx = resolveManagedProxyContext();
      const model = resolveModel(config, "gemini");
      registerProvider(
        "gemini",
        new RetryProvider(
          wrapWithLogfire(
            new GeminiProvider(ctx.assistantApiKey, model, {
              streamTimeoutMs,
              managedBaseUrl,
            }),
          ),
        ),
      );
      routingSources.set("gemini", "managed-proxy");
    }
  }
  const ollamaKey = getSecureKey("ollama");
  if (config.provider === "ollama" || ollamaKey) {
    const model = resolveModel(config, "ollama");
    registerProvider(
      "ollama",
      new RetryProvider(
        wrapWithLogfire(
          new OllamaProvider(model, {
            apiKey: ollamaKey ?? undefined,
            streamTimeoutMs,
          }),
        ),
      ),
    );
    routingSources.set("ollama", "user-key");
  }
  const fireworksKey = getSecureKey("fireworks");
  if (fireworksKey) {
    const model = resolveModel(config, "fireworks");
    registerProvider(
      "fireworks",
      new RetryProvider(
        wrapWithLogfire(
          new FireworksProvider(fireworksKey, model, {
            streamTimeoutMs,
          }),
        ),
      ),
    );
    routingSources.set("fireworks", "user-key");
  } else {
    const managedBaseUrl = buildManagedBaseUrl("fireworks");
    if (managedBaseUrl) {
      const ctx = resolveManagedProxyContext();
      const model = resolveModel(config, "fireworks");
      registerProvider(
        "fireworks",
        new RetryProvider(
          wrapWithLogfire(
            new FireworksProvider(ctx.assistantApiKey, model, {
              baseURL: managedBaseUrl,
              streamTimeoutMs,
            }),
          ),
        ),
      );
      routingSources.set("fireworks", "managed-proxy");
    }
  }
  const openrouterKey = getSecureKey("openrouter");
  if (openrouterKey) {
    const model = resolveModel(config, "openrouter");
    registerProvider(
      "openrouter",
      new RetryProvider(
        wrapWithLogfire(
          new OpenRouterProvider(openrouterKey, model, {
            streamTimeoutMs,
          }),
        ),
      ),
    );
    routingSources.set("openrouter", "user-key");
  } else {
    const managedBaseUrl = buildManagedBaseUrl("openrouter");
    if (managedBaseUrl) {
      const ctx = resolveManagedProxyContext();
      const model = resolveModel(config, "openrouter");
      registerProvider(
        "openrouter",
        new RetryProvider(
          wrapWithLogfire(
            new OpenRouterProvider(ctx.assistantApiKey, model, {
              baseURL: managedBaseUrl,
              streamTimeoutMs,
            }),
          ),
        ),
      );
      routingSources.set("openrouter", "managed-proxy");
    }
  }
}

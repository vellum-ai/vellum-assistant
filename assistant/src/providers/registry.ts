import type { Provider } from "./types.js";
import { AnthropicProvider } from "./anthropic/client.js";
import { OpenAIProvider } from "./openai/client.js";
import { GeminiProvider } from "./gemini/client.js";
import { OllamaProvider } from "./ollama/client.js";
import { FireworksProvider } from "./fireworks/client.js";
import { OpenRouterProvider } from "./openrouter/client.js";
import { RetryProvider } from "./retry.js";
import { FailoverProvider } from "./failover.js";
import { wrapWithLogfire } from "../logfire.js";
import { ConfigError } from "../util/errors.js";

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-opus-4-6',
  openai: 'gpt-5.2',
  gemini: 'gemini-3-flash',
  ollama: 'llama3.2',
  fireworks: 'accounts/fireworks/models/kimi-k2p5',
  openrouter: 'anthropic/claude-sonnet-4',
};

const providers = new Map<string, Provider>();
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

/**
 * Build a provider that tries the primary provider first, then falls back to
 * others in the configured order. If providerOrder is empty or only contains
 * the primary, returns the primary provider directly (no wrapper overhead).
 * Caches the FailoverProvider instance so health state persists across calls.
 */
export function getFailoverProvider(primaryName: string, providerOrder: string[]): Provider {
  const primary = getProvider(primaryName);

  // Build the ordered list: primary first, then remaining from providerOrder
  const orderedProviders: Provider[] = [primary];
  const seen = new Set<string>([primaryName]);

  for (const name of providerOrder) {
    if (seen.has(name)) continue;
    const p = providers.get(name);
    if (p) {
      orderedProviders.push(p);
      seen.add(name);
    }
  }

  if (orderedProviders.length === 1) {
    return primary;
  }

  const cacheKey = `${primaryName}:${providerOrder.join(',')}`;
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

export interface ProvidersConfig {
  apiKeys: Record<string, string>;
  provider: string;
  model: string;
  webSearchProvider?: string;
  timeouts?: { providerStreamTimeoutSec?: number };
}

function resolveModel(config: ProvidersConfig, providerName: keyof typeof DEFAULT_MODELS): string {
  if (config.provider === providerName) {
    // If a non-Anthropic provider is selected with the untouched global default
    // model, use a provider-appropriate fallback instead.
    if (providerName !== 'anthropic' && config.model === DEFAULT_MODELS.anthropic) {
      return DEFAULT_MODELS[providerName];
    }
    return config.model;
  }
  return DEFAULT_MODELS[providerName];
}

export function initializeProviders(config: ProvidersConfig): void {
  providers.clear();
  cachedFailoverProvider = null;
  cachedFailoverKey = null;

  const streamTimeoutMs = (config.timeouts?.providerStreamTimeoutSec ?? 300) * 1000;

  if (config.apiKeys.anthropic) {
    const model = resolveModel(config, 'anthropic');
    registerProvider('anthropic', new RetryProvider(
      wrapWithLogfire(new AnthropicProvider(config.apiKeys.anthropic, model, {
        useNativeWebSearch: config.webSearchProvider === 'anthropic-native',
        streamTimeoutMs,
      })),
    ));
  }
  if (config.apiKeys.openai) {
    const model = resolveModel(config, 'openai');
    registerProvider('openai', new RetryProvider(
      wrapWithLogfire(new OpenAIProvider(config.apiKeys.openai, model, { streamTimeoutMs })),
    ));
  }
  if (config.apiKeys.gemini) {
    const model = resolveModel(config, 'gemini');
    registerProvider('gemini', new RetryProvider(
      wrapWithLogfire(new GeminiProvider(config.apiKeys.gemini, model, { streamTimeoutMs })),
    ));
  }
  if (config.provider === 'ollama' || config.apiKeys.ollama) {
    const model = resolveModel(config, 'ollama');
    registerProvider('ollama', new RetryProvider(
      wrapWithLogfire(new OllamaProvider(model, { apiKey: config.apiKeys.ollama, streamTimeoutMs })),
    ));
  }
  if (config.apiKeys.fireworks) {
    const model = resolveModel(config, 'fireworks');
    registerProvider('fireworks', new RetryProvider(
      wrapWithLogfire(new FireworksProvider(config.apiKeys.fireworks, model, { streamTimeoutMs })),
    ));
  }
  if (config.apiKeys.openrouter) {
    const model = resolveModel(config, 'openrouter');
    registerProvider('openrouter', new RetryProvider(
      wrapWithLogfire(new OpenRouterProvider(config.apiKeys.openrouter, model, { streamTimeoutMs })),
    ));
  }
}

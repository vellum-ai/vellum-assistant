import type { Provider } from "./types.js";
import { AnthropicProvider } from "./anthropic/client.js";
import { OpenAIProvider } from "./openai/client.js";
import { GeminiProvider } from "./gemini/client.js";
import { OllamaProvider } from "./ollama/client.js";
import { FireworksProvider } from "./fireworks/client.js";
import { RetryProvider } from "./retry.js";
import { ConfigError } from "../util/errors.js";

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-opus-4-6',
  openai: 'gpt-5.2',
  gemini: 'gemini-3-flash',
  ollama: 'llama3.2',
  fireworks: 'accounts/fireworks/models/kimi-k2p5',
};

const providers = new Map<string, Provider>();

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

export function listProviders(): string[] {
  return Array.from(providers.keys());
}

export interface ProvidersConfig {
  apiKeys: Record<string, string>;
  provider: string;
  model: string;
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

  if (config.apiKeys.anthropic) {
    const model = resolveModel(config, 'anthropic');
    registerProvider('anthropic', new RetryProvider(
      new AnthropicProvider(config.apiKeys.anthropic, model),
    ));
  }
  if (config.apiKeys.openai) {
    const model = resolveModel(config, 'openai');
    registerProvider('openai', new RetryProvider(
      new OpenAIProvider(config.apiKeys.openai, model),
    ));
  }
  if (config.apiKeys.gemini) {
    const model = resolveModel(config, 'gemini');
    registerProvider('gemini', new RetryProvider(
      new GeminiProvider(config.apiKeys.gemini, model),
    ));
  }
  if (config.provider === 'ollama' || config.apiKeys.ollama) {
    const model = resolveModel(config, 'ollama');
    registerProvider('ollama', new RetryProvider(
      new OllamaProvider(model, { apiKey: config.apiKeys.ollama }),
    ));
  }
  if (config.apiKeys.fireworks) {
    const model = resolveModel(config, 'fireworks');
    registerProvider('fireworks', new RetryProvider(
      new FireworksProvider(config.apiKeys.fireworks, model),
    ));
  }
}

import type { Provider } from "./types.js";
import { AnthropicProvider } from "./anthropic/client.js";
import { RetryProvider } from "./retry.js";
import { ConfigError } from "../util/errors.js";

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

export function initializeProviders(config: ProvidersConfig): void {
  if (config.apiKeys.anthropic) {
    const provider = new RetryProvider(
      new AnthropicProvider(config.apiKeys.anthropic, config.model),
    );
    registerProvider("anthropic", provider);
  }
}

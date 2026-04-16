import { getProviderKeyAsync } from "../security/secure-keys.js";
import { ProviderNotConfiguredError } from "../util/errors.js";
import { AnthropicProvider } from "./anthropic/client.js";
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

export function registerProvider(name: string, provider: Provider): void {
  providers.set(name, provider);
}

export function getProvider(name: string): Provider {
  const provider = providers.get(name);
  if (!provider) {
    throw new ProviderNotConfiguredError(name, listProviders());
  }
  return provider;
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
  services: {
    inference: {
      mode: "managed" | "your-own";
    };
    "image-generation": {
      mode: "managed" | "your-own";
      provider: string;
      model: string;
    };
    "web-search": {
      mode: "managed" | "your-own";
      provider: string;
    };
  };
  llm: {
    default: {
      provider: string;
      model: string;
    };
  };
  timeouts?: { providerStreamTimeoutSec?: number };
}

function resolveModel(config: ProvidersConfig, providerName: string): string {
  const inferenceProvider = config.llm.default.provider;
  const inferenceModel = config.llm.default.model;
  if (inferenceProvider === providerName) {
    // If a non-Anthropic provider is selected with the untouched global default
    // model, use a provider-appropriate fallback instead.
    if (
      providerName !== "anthropic" &&
      inferenceModel === getProviderDefaultModel("anthropic")
    ) {
      return getProviderDefaultModel(providerName);
    }
    return inferenceModel;
  }
  return getProviderDefaultModel(providerName);
}

/**
 * Resolve provider credentials using mode-aware logic.
 * In "managed" mode, routes through the platform proxy.
 * In "your-own" mode, uses the user's API key.
 */
async function resolveProviderCredentials(
  providerName: string,
  mode: "managed" | "your-own",
): Promise<{
  apiKey: string;
  baseURL?: string;
  source: "user-key" | "managed-proxy";
} | null> {
  if (mode === "managed") {
    // In managed mode, try managed proxy first, then fall back to user key
    const managedBaseUrl = await buildManagedBaseUrl(providerName);
    if (managedBaseUrl) {
      const ctx = await resolveManagedProxyContext();
      return {
        apiKey: ctx.assistantApiKey,
        baseURL: managedBaseUrl,
        source: "managed-proxy",
      };
    }
    // Managed proxy unavailable for this provider; fall back to user key
    const userKey = await getProviderKeyAsync(providerName);
    if (userKey) {
      return { apiKey: userKey, source: "user-key" };
    }
    return null;
  }
  // "your-own" mode: check user key first, then try managed proxy fallback
  const userKey = await getProviderKeyAsync(providerName);
  if (userKey) {
    return { apiKey: userKey, source: "user-key" };
  }
  // Fall back to managed proxy even in your-own mode (backwards compat)
  const managedBaseUrl = await buildManagedBaseUrl(providerName);
  if (managedBaseUrl) {
    const ctx = await resolveManagedProxyContext();
    return {
      apiKey: ctx.assistantApiKey,
      baseURL: managedBaseUrl,
      source: "managed-proxy",
    };
  }
  return null;
}

export async function initializeProviders(
  config: ProvidersConfig,
): Promise<void> {
  providers.clear();
  routingSources.clear();

  const streamTimeoutMs =
    (config.timeouts?.providerStreamTimeoutSec ?? 1800) * 1000;
  const inferenceMode = config.services.inference.mode;
  const useNativeWebSearch =
    config.services["web-search"].provider === "inference-provider-native";

  // Anthropic
  const anthropicCreds = await resolveProviderCredentials(
    "anthropic",
    inferenceMode,
  );
  if (anthropicCreds) {
    const model = resolveModel(config, "anthropic");
    registerProvider(
      "anthropic",
      new RetryProvider(
        new AnthropicProvider(anthropicCreds.apiKey, model, {
          useNativeWebSearch,
          streamTimeoutMs,
          ...(anthropicCreds.baseURL
            ? { baseURL: anthropicCreds.baseURL }
            : {}),
        }),
      ),
    );
    routingSources.set("anthropic", anthropicCreds.source);
  }

  // OpenAI
  const openaiCreds = await resolveProviderCredentials("openai", inferenceMode);
  if (openaiCreds) {
    const model = resolveModel(config, "openai");
    registerProvider(
      "openai",
      new RetryProvider(
        new OpenAIProvider(openaiCreds.apiKey, model, {
          streamTimeoutMs,
          ...(openaiCreds.baseURL ? { baseURL: openaiCreds.baseURL } : {}),
        }),
      ),
    );
    routingSources.set("openai", openaiCreds.source);
  }

  // Gemini
  const geminiCreds = await resolveProviderCredentials("gemini", inferenceMode);
  if (geminiCreds) {
    const model = resolveModel(config, "gemini");
    registerProvider(
      "gemini",
      new RetryProvider(
        new GeminiProvider(geminiCreds.apiKey, model, {
          streamTimeoutMs,
          ...(geminiCreds.baseURL
            ? { managedBaseUrl: geminiCreds.baseURL }
            : {}),
        }),
      ),
    );
    routingSources.set("gemini", geminiCreds.source);
  }

  // Ollama (keyless provider — always init when configured or key present)
  const ollamaKey = await getProviderKeyAsync("ollama");
  if (config.llm.default.provider === "ollama" || ollamaKey) {
    const model = resolveModel(config, "ollama");
    registerProvider(
      "ollama",
      new RetryProvider(
        new OllamaProvider(model, {
          apiKey: ollamaKey ?? undefined,
          streamTimeoutMs,
        }),
      ),
    );
    routingSources.set("ollama", "user-key");
  }

  // Fireworks
  const fireworksKey = await getProviderKeyAsync("fireworks");
  if (fireworksKey) {
    const model = resolveModel(config, "fireworks");
    registerProvider(
      "fireworks",
      new RetryProvider(
        new FireworksProvider(fireworksKey, model, {
          streamTimeoutMs,
        }),
      ),
    );
    routingSources.set("fireworks", "user-key");
  }

  // OpenRouter
  const openrouterKey = await getProviderKeyAsync("openrouter");
  if (openrouterKey) {
    const model = resolveModel(config, "openrouter");
    registerProvider(
      "openrouter",
      new RetryProvider(
        new OpenRouterProvider(openrouterKey, model, {
          streamTimeoutMs,
        }),
      ),
    );
    routingSources.set("openrouter", "user-key");
  }
}

import { getProviderKeyAsync } from "../security/secure-keys.js";
import { ProviderNotConfiguredError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import { AnthropicProvider } from "./anthropic/client.js";
import { FireworksProvider } from "./fireworks/client.js";
import { GeminiProvider } from "./gemini/client.js";
import { createAdapterFromConnection } from "./inference/adapter-factory.js";
// ---------------------------------------------------------------------------
// Per-connection provider cache (mix-and-match support)
// ---------------------------------------------------------------------------
import type { ProviderConnection } from "./inference/auth.js";
import { resolveAuth } from "./inference/resolve-auth.js";
import {
  buildManagedBaseUrl,
  resolveManagedProxyContext,
} from "./managed-proxy/context.js";
import { isModelInCatalog } from "./model-catalog.js";
import { getProviderDefaultModel } from "./model-intents.js";
import { OllamaProvider } from "./ollama/client.js";
import { OpenAIResponsesProvider } from "./openai/client.js";
import { OpenRouterProvider } from "./openrouter/client.js";
import { RetryProvider } from "./retry.js";
import type { Provider } from "./types.js";
import { UsageTrackingProvider } from "./usage-tracking.js";

const log = getLogger("provider-registry");

const providers = new Map<string, Provider>();
const routingSources = new Map<string, "user-key" | "managed-proxy">();

/** Per-connection provider cache, keyed by connection name. */
const connectionProviders = new Map<string, Provider>();

function registerProvider(name: string, provider: Provider): void {
  providers.set(name, new UsageTrackingProvider(provider));
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

export interface ProvidersConfig {
  services: {
    inference: Record<string, never>;
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
      /**
       * Name of a `provider_connections` row to use for this profile.
       * Mirrors the runtime field added by `profileConfigFragment` in
       * `config/llm-resolver.ts` and the Zod field on `LLMConfigBase`
       * in `config/schemas/llm.ts`. Optional at the type level so
       * pre-backfill / hand-crafted configs still compile; the
       * connection-resolution helpers throw a clear configuration
       * error when a profile has no connection at dispatch time.
       */
      provider_connection?: string;
    };
  };
  timeouts?: { providerStreamTimeoutSec?: number };
}

function resolveModel(config: ProvidersConfig, providerName: string): string {
  const inferenceProvider = config.llm.default.provider;
  const inferenceModel = config.llm.default.model;
  if (inferenceProvider === providerName) {
    if (
      providerName !== "anthropic" &&
      isModelInCatalog("anthropic", inferenceModel)
    ) {
      return getProviderDefaultModel(providerName);
    }
    return inferenceModel;
  }
  return getProviderDefaultModel(providerName);
}

/**
 * Resolve provider credentials. User key takes precedence; managed proxy is
 * used as a fallback when platform prerequisites are available.
 *
 * The routing decision is now derived from credential availability rather than
 * the removed `services.inference.mode` config field.
 */
async function resolveProviderCredentials(
  providerName: string,
): Promise<{
  apiKey: string;
  baseURL?: string;
  source: "user-key" | "managed-proxy";
} | null> {
  const userKey = await getProviderKeyAsync(providerName);
  if (userKey) {
    return { apiKey: userKey, source: "user-key" };
  }
  const managedBaseUrl = await buildManagedBaseUrl(providerName);
  if (managedBaseUrl) {
    const ctx = await resolveManagedProxyContext();
    return { apiKey: ctx.assistantApiKey, baseURL: managedBaseUrl, source: "managed-proxy" };
  }
  return null;
}

export async function initializeProviders(
  config: ProvidersConfig,
): Promise<void> {
  providers.clear();
  routingSources.clear();
  connectionProviders.clear();

  const streamTimeoutMs =
    (config.timeouts?.providerStreamTimeoutSec ?? 1800) * 1000;
  const useNativeWebSearch =
    config.services["web-search"].provider === "inference-provider-native";

  // Anthropic
  const anthropicCreds = await resolveProviderCredentials("anthropic");
  if (anthropicCreds) {
    const model = resolveModel(config, "anthropic");
    registerProvider(
      "anthropic",
      new RetryProvider(
        new AnthropicProvider(anthropicCreds.apiKey, model, {
          useNativeWebSearch,
          streamTimeoutMs,
          ...(anthropicCreds.baseURL ? { baseURL: anthropicCreds.baseURL } : {}),
        }),
        { forwardUsageAttributionHeaders: anthropicCreds.source === "managed-proxy" },
      ),
    );
    routingSources.set("anthropic", anthropicCreds.source);
  }

  // OpenAI
  const openaiCreds = await resolveProviderCredentials("openai");
  if (openaiCreds) {
    const model = resolveModel(config, "openai");
    registerProvider(
      "openai",
      new RetryProvider(
        new OpenAIResponsesProvider(openaiCreds.apiKey, model, {
          useNativeWebSearch,
          streamTimeoutMs,
          ...(openaiCreds.baseURL ? { baseURL: openaiCreds.baseURL } : {}),
        }),
        { forwardUsageAttributionHeaders: openaiCreds.source === "managed-proxy" },
      ),
    );
    routingSources.set("openai", openaiCreds.source);
  }

  // Gemini
  const geminiCreds = await resolveProviderCredentials("gemini");
  if (geminiCreds) {
    const model = resolveModel(config, "gemini");
    registerProvider(
      "gemini",
      new RetryProvider(
        new GeminiProvider(geminiCreds.apiKey, model, {
          streamTimeoutMs,
          ...(geminiCreds.baseURL ? { managedBaseUrl: geminiCreds.baseURL } : {}),
        }),
        { forwardUsageAttributionHeaders: geminiCreds.source === "managed-proxy" },
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
          useNativeWebSearch,
          streamTimeoutMs,
        }),
      ),
    );
    routingSources.set("openrouter", "user-key");
  }
}

// ---------------------------------------------------------------------------
// Per-connection provider resolution (mix-and-match support)
// ---------------------------------------------------------------------------

/**
 * Resolve a provider instance for a named `provider_connection`.
 *
 * Results are cached in `connectionProviders` for the lifetime of the
 * current `initializeProviders` invocation (cleared on next boot). This
 * prevents redundant vault reads for repeated calls to the same connection.
 *
 * Returns null when:
 *   - The connection doesn't exist in the DB
 *   - Auth resolution fails (missing credential, platform unavailable, v2 type)
 *   - The provider/auth combination yields no usable adapter
 */
export async function resolveProviderFromConnection(
  connection: ProviderConnection,
  config: ProvidersConfig,
): Promise<Provider | null> {
  const cached = connectionProviders.get(connection.name);
  if (cached) return cached;

  const authResult = await resolveAuth(connection.auth, connection.provider);
  if (!authResult.ok) {
    const err = authResult.error;
    if (err.code === "not_implemented") {
      log.warn(
        { connectionName: connection.name, authType: err.authType },
        `Auth type '${err.authType}' is not yet implemented (v2). ` +
          "Update the connection to use 'api_key', 'platform', or 'none'.",
      );
    } else if (err.code === "credential_not_found") {
      log.warn(
        { connectionName: connection.name, credential: err.credential },
        `Credential '${err.credential}' not found in vault for connection '${connection.name}'.`,
      );
    } else {
      log.warn(
        { connectionName: connection.name },
        `Platform auth unavailable for connection '${connection.name}'.`,
      );
    }
    return null;
  }

  const streamTimeoutMs =
    (config.timeouts?.providerStreamTimeoutSec ?? 1800) * 1000;
  const useNativeWebSearch =
    config.services["web-search"].provider === "inference-provider-native";
  const model = resolveModel(config, connection.provider);

  const provider = createAdapterFromConnection(connection, authResult.resolved, {
    model,
    streamTimeoutMs,
    useNativeWebSearch,
  });

  if (provider) {
    connectionProviders.set(connection.name, provider);
  }

  return provider;
}

/** Clear per-connection provider cache (called by initializeProviders on boot). */
export function clearConnectionProviderCache(): void {
  connectionProviders.clear();
}

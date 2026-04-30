import { getProviderKeyAsync } from "../security/secure-keys.js";
import { ProviderNotConfiguredError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import { AnthropicProvider } from "./anthropic/client.js";
import { FireworksProvider } from "./fireworks/client.js";
import { GeminiProvider } from "./gemini/client.js";
import {
  buildManagedBaseUrl,
  resolveManagedProxyContext,
} from "./managed-proxy/context.js";
import { isModelInCatalog } from "./model-catalog.js";
import { getProviderDefaultModel } from "./model-intents.js";
import { OllamaProvider } from "./ollama/client.js";
import { OpenAIResponsesProvider } from "./openai/client.js";
import { getOpenAICodexCredentials } from "./openai/codex-credentials.js";
import { OpenRouterProvider } from "./openrouter/client.js";
import { RetryProvider } from "./retry.js";
import type { Provider } from "./types.js";

const log = getLogger("provider-registry");

export type ProviderRoutingSource =
  | "user-key"
  | "managed-proxy"
  | "oauth-codex";

const providers = new Map<string, Provider>();
const routingSources = new Map<string, ProviderRoutingSource>();

const CODEX_OAUTH_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_OAUTH_ORIGINATOR = "vellum-assistant";

function isCodexOAuthEnabled(): boolean {
  return process.env.VELLUM_ENABLE_OPENAI_CODEX_OAUTH === "1";
}

function registerProvider(name: string, provider: Provider): void {
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
): ProviderRoutingSource | undefined {
  return routingSources.get(name);
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
    // If a non-Anthropic provider is selected but the configured model is
    // still an Anthropic catalog model (current or previous default), use a
    // provider-appropriate fallback instead. Checking the full Anthropic
    // catalog rather than only the current default prevents stale persisted
    // defaults (e.g. claude-opus-4-6) from being sent to non-Anthropic APIs
    // after the catalog default changes.
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

  // OpenAI — OAuth (Sign in with ChatGPT) takes precedence over API key
  // when the feature flag is on and credentials are present. The Codex
  // backend speaks the Responses API but at chatgpt.com/backend-api/codex,
  // not api.openai.com/v1, and gates on subscription-specific headers.
  const codexCreds = isCodexOAuthEnabled()
    ? await getOpenAICodexCredentials()
    : undefined;
  if (codexCreds) {
    const model = resolveModel(config, "openai");
    registerProvider(
      "openai",
      new RetryProvider(
        new OpenAIResponsesProvider(codexCreds.access, model, {
          // Codex backend rejects `web_search_preview`; force the function-tool
          // path so the assistant's own web-search mechanism is used.
          useNativeWebSearch: false,
          streamTimeoutMs,
          baseURL: CODEX_OAUTH_BASE_URL,
          defaultHeaders: {
            "chatgpt-account-id": codexCreds.accountId,
            "OpenAI-Beta": "responses=experimental",
            originator: CODEX_OAUTH_ORIGINATOR,
          },
          onAuthRefreshNeeded: async () => {
            const refreshed = await getOpenAICodexCredentials({
              forceRefresh: true,
            });
            return refreshed?.access;
          },
        }),
      ),
    );
    routingSources.set("openai", "oauth-codex");
    log.info(
      { accountId: codexCreds.accountId },
      "Registered OpenAI provider via Codex OAuth",
    );
  } else {
    const openaiCreds = await resolveProviderCredentials(
      "openai",
      inferenceMode,
    );
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
        ),
      );
      routingSources.set("openai", openaiCreds.source);
    }
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
          useNativeWebSearch,
          streamTimeoutMs,
        }),
      ),
    );
    routingSources.set("openrouter", "user-key");
  }
}

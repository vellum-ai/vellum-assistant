/**
 * Creates provider adapter instances from a resolved auth + connection.
 *
 * Adapters are created per-call when dispatching through a named
 * `provider_connection`, enabling mix-and-match auth (e.g. managed and
 * your-own Anthropic connections coexisting in the same registry).
 */

import { AnthropicProvider } from "../anthropic/client.js";
import { FireworksProvider } from "../fireworks/client.js";
import { GeminiProvider } from "../gemini/client.js";
import { OllamaProvider } from "../ollama/client.js";
import { OpenAIResponsesProvider } from "../openai/responses-provider.js";
import { OpenRouterProvider } from "../openrouter/client.js";
import { RetryProvider } from "../retry.js";
import type { Provider } from "../types.js";
import { UsageTrackingProvider } from "../usage-tracking.js";
import type { ResolvedAuth } from "./auth.js";
import type { ProviderConnection } from "./auth.js";

export interface AdapterOptions {
  model: string;
  streamTimeoutMs?: number;
  useNativeWebSearch?: boolean;
}

/**
 * Build a Provider instance for a given connection + resolved auth.
 *
 * Returns null when the provider/auth combination is not usable
 * (e.g. `none` auth on a keyed provider). The caller decides whether to
 * log a warning or fall back to the global registry.
 */
export function createAdapterFromConnection(
  connection: ProviderConnection,
  resolvedAuth: ResolvedAuth,
  opts: AdapterOptions,
): Provider | null {
  const { provider } = connection;
  const { model, streamTimeoutMs = 1_800_000, useNativeWebSearch = false } = opts;

  let adapter: Provider | null = null;

  switch (provider) {
    case "anthropic": {
      if (resolvedAuth.kind === "none") return null;
      const apiKey =
        resolvedAuth.kind === "header"
          ? (resolvedAuth.headers["Authorization"] ?? "").replace(/^Bearer /, "")
          : "";
      adapter = new AnthropicProvider(apiKey, model, {
        useNativeWebSearch,
        streamTimeoutMs,
        ...(resolvedAuth.kind === "header" && resolvedAuth.baseUrl
          ? { baseURL: resolvedAuth.baseUrl }
          : {}),
      });
      break;
    }

    case "openai": {
      if (resolvedAuth.kind === "none") return null;
      const apiKey =
        resolvedAuth.kind === "header"
          ? (resolvedAuth.headers["Authorization"] ?? "").replace(/^Bearer /, "")
          : "";
      adapter = new OpenAIResponsesProvider(apiKey, model, {
        useNativeWebSearch,
        streamTimeoutMs,
        ...(resolvedAuth.kind === "header" && resolvedAuth.baseUrl
          ? { baseURL: resolvedAuth.baseUrl }
          : {}),
      });
      break;
    }

    case "gemini": {
      if (resolvedAuth.kind === "none") return null;
      const apiKey =
        resolvedAuth.kind === "header"
          ? (resolvedAuth.headers["Authorization"] ?? "").replace(/^Bearer /, "")
          : "";
      adapter = new GeminiProvider(apiKey, model, {
        streamTimeoutMs,
        ...(resolvedAuth.kind === "header" && resolvedAuth.baseUrl
          ? { managedBaseUrl: resolvedAuth.baseUrl }
          : {}),
      });
      break;
    }

    case "ollama": {
      // Ollama supports no-auth operation; header auth is also accepted (API key param).
      const apiKey =
        resolvedAuth.kind === "header"
          ? (resolvedAuth.headers["Authorization"] ?? "").replace(/^Bearer /, "")
          : undefined;
      adapter = new OllamaProvider(model, {
        apiKey: apiKey ?? undefined,
        streamTimeoutMs,
      });
      break;
    }

    case "fireworks": {
      if (resolvedAuth.kind === "none") return null;
      const apiKey =
        resolvedAuth.kind === "header"
          ? (resolvedAuth.headers["Authorization"] ?? "").replace(/^Bearer /, "")
          : "";
      adapter = new FireworksProvider(apiKey, model, { streamTimeoutMs });
      break;
    }

    case "openrouter": {
      if (resolvedAuth.kind === "none") return null;
      const apiKey =
        resolvedAuth.kind === "header"
          ? (resolvedAuth.headers["Authorization"] ?? "").replace(/^Bearer /, "")
          : "";
      adapter = new OpenRouterProvider(apiKey, model, {
        useNativeWebSearch,
        streamTimeoutMs,
      });
      break;
    }

    default:
      return null;
  }

  if (!adapter) return null;

  const isProxy =
    resolvedAuth.kind === "header" && resolvedAuth.baseUrl !== undefined;

  return new UsageTrackingProvider(
    new RetryProvider(adapter, {
      forwardUsageAttributionHeaders: isProxy,
    }),
  );
}

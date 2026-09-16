import { getModelsForProvider } from "@/assistant/llm-model-catalog";
import { codexServableModels } from "@/domains/settings/ai/codex-subscription-models";
import {
  CHATGPT_CONNECTION_PROVIDER,
  VELLUM_CONNECTION_PROVIDER,
} from "@/domains/settings/ai/constants";
import type {
  DefaultProviderStatus,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

export type DefaultProviderId = NonNullable<DefaultProviderStatus["provider"]>;

// Exhaustive against the generated union: a provider added to or removed
// from the daemon's default-provider enum fails compilation here.
const DEFAULT_PROVIDER_ELIGIBLE: Record<DefaultProviderId, true> = {
  anthropic: true,
  openai: true,
  gemini: true,
  fireworks: true,
  openrouter: true,
  chatgpt: true,
  vellum: true,
  together: true,
  "vercel-ai-gateway": true,
  minimax: true,
  atlascloud: true,
  baseten: true,
  poolside: true,
};

export function isDefaultProviderId(
  provider: string,
): provider is DefaultProviderId {
  return provider in DEFAULT_PROVIDER_ELIGIBLE;
}

/**
 * Endpoint meta for a custom (openai-compatible) provider: the endpoint
 * host plus what it serves, e.g. "api.x.ai · 2 models" or
 * "127.0.0.1:1234 · keyless".
 */
function connectionHost(conn: ProviderConnection): string | null {
  if (!conn.baseUrl) {
    return null;
  }
  try {
    return new URL(conn.baseUrl).host;
  } catch {
    return conn.baseUrl;
  }
}

function customProviderMeta(conn: ProviderConnection): string {
  const host = connectionHost(conn) ?? "";
  const parts: string[] = [];
  if (host) {
    parts.push(host);
  }
  const modelCount = conn.models?.length ?? 0;
  if (modelCount > 0) {
    parts.push(`${modelCount} ${modelCount === 1 ? "model" : "models"}`);
  }
  if (conn.auth.type === "none") {
    parts.push("keyless");
  }
  return parts.join(" · ");
}

function authMeta(conn: ProviderConnection): string | null {
  switch (conn.auth.type) {
    case "api_key":
      return "Own API key";
    case "oauth_subscription":
      return "ChatGPT subscription";
    case "none":
      return "No API key needed";
    default:
      return null;
  }
}

/**
 * Subtitle for a Providers row (Figma 7412:133539): what the connection
 * serves and how it authenticates, e.g. "8 models  •  Own API key",
 * "Included with your plan" for the managed Vellum row, or the endpoint
 * meta for a custom provider.
 */
export function providerRowMeta(conn: ProviderConnection): string {
  if (conn.provider === VELLUM_CONNECTION_PROVIDER) {
    return "Included with your plan";
  }
  if (conn.provider === "openai-compatible") {
    return customProviderMeta(conn);
  }
  const parts: string[] = [];
  if (conn.provider === "ollama" || conn.provider === "opencode") {
    const host = connectionHost(conn);
    if (host) {
      parts.push(host);
    }
  }
  // A subscription connection hard-routes to the Codex endpoint, which
  // serves only the Codex model set; counting the full catalog would
  // advertise models the connection cannot dispatch. The row's models come
  // from the OpenAI catalog whether it stores provider "openai" or the
  // "chatgpt" identity daemon migration 366 stamps.
  const catalogProvider =
    conn.provider === CHATGPT_CONNECTION_PROVIDER ? "openai" : conn.provider;
  const catalogModels =
    conn.auth.type === "oauth_subscription"
      ? codexServableModels(catalogProvider)
      : getModelsForProvider(catalogProvider);
  const modelCount = conn.models?.length ?? catalogModels.length;
  if (modelCount > 0) {
    parts.push(`${modelCount} ${modelCount === 1 ? "model" : "models"}`);
  }
  const auth = authMeta(conn);
  if (auth) {
    parts.push(auth);
  }
  return parts.join("  •  ");
}

/**
 * Provider model-listing request recipes.
 *
 * A recipe describes how to ask a provider which models a credential can
 * reach: the endpoint, the static headers, and the slot the credential is
 * injected into. It deliberately carries no credential. The credential
 * executor fills the slot from its own store and performs the request, so a
 * caller that holds a recipe still cannot read the secret.
 *
 * Endpoint references:
 *   https://platform.claude.com/docs/en/api/models-list
 *   https://developers.openai.com/api/docs/models
 *   https://ai.google.dev/api/models#method:-models.list
 */

import type { ProbeCredentialInjection } from "@vellumai/credential-storage";

import { DEFAULT_ATLASCLOUD_BASE_URL } from "./atlascloud/client.js";
import { DEFAULT_BASETEN_BASE_URL } from "./baseten/client.js";
import { DEFAULT_FIREWORKS_BASE_URL } from "./fireworks/client.js";
import { DEFAULT_OPENROUTER_BASE_URL } from "./openrouter/client.js";
import { DEFAULT_TOGETHER_BASE_URL } from "./together/client.js";
import { DEFAULT_VERCEL_AI_GATEWAY_BASE_URL } from "./vercel-ai-gateway/client.js";

/** A provider's model-listing request with the credential left out. */
export interface ModelListingRequest {
  url: string;
  headers?: Record<string, string>;
  credentialInjection: ProbeCredentialInjection;
}

interface ModelListingRecipe {
  /** Upstream used when the connection does not override `baseUrl`. */
  defaultBaseUrl?: string;
  /** Path appended to the base URL. */
  path: string;
  headers?: Record<string, string>;
  credentialInjection: ProbeCredentialInjection;
}

/** OpenAI-compatible upstreams share the `GET {base}/models` + bearer shape. */
function openAiCompatible(defaultBaseUrl?: string): ModelListingRecipe {
  return {
    ...(defaultBaseUrl ? { defaultBaseUrl } : {}),
    path: "/models",
    credentialInjection: {
      kind: "header",
      name: "authorization",
      prefix: "Bearer ",
    },
  };
}

/**
 * Providers whose credential can be checked against a model listing. Keyless
 * providers (ollama) and platform-authenticated connections have no stored
 * provider credential to probe, so they are absent by design.
 */
const MODEL_LISTING_RECIPES: Record<string, ModelListingRecipe> = {
  anthropic: {
    defaultBaseUrl: "https://api.anthropic.com/v1",
    path: "/models",
    headers: { "anthropic-version": "2023-06-01" },
    credentialInjection: { kind: "header", name: "x-api-key" },
  },
  openai: openAiCompatible("https://api.openai.com/v1"),
  gemini: {
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    path: "/models",
    // The API key also travels as a `key` query parameter, but a header keeps
    // it out of URLs, which are far more likely to be logged.
    credentialInjection: { kind: "header", name: "x-goog-api-key" },
  },
  fireworks: openAiCompatible(DEFAULT_FIREWORKS_BASE_URL),
  together: openAiCompatible(DEFAULT_TOGETHER_BASE_URL),
  openrouter: openAiCompatible(DEFAULT_OPENROUTER_BASE_URL),
  "vercel-ai-gateway": openAiCompatible(DEFAULT_VERCEL_AI_GATEWAY_BASE_URL),
  atlascloud: openAiCompatible(DEFAULT_ATLASCLOUD_BASE_URL),
  baseten: openAiCompatible(DEFAULT_BASETEN_BASE_URL),
  // Self-hosted upstreams carry no default: the connection supplies the base URL.
  litellm: openAiCompatible(),
  "openai-compatible": openAiCompatible(),
};

/**
 * Build the model-listing request for a provider, or null when the provider
 * has no listing endpoint the probe can use or the connection supplies no
 * base URL for a self-hosted upstream.
 */
export function buildModelListingRequest(
  provider: string,
  baseUrl?: string | null,
): ModelListingRequest | null {
  const recipe = MODEL_LISTING_RECIPES[provider];
  if (!recipe) {
    return null;
  }
  const base = (baseUrl ?? recipe.defaultBaseUrl)?.replace(/\/+$/, "");
  if (!base) {
    return null;
  }
  return {
    url: `${base}${recipe.path}`,
    ...(recipe.headers ? { headers: recipe.headers } : {}),
    credentialInjection: recipe.credentialInjection,
  };
}

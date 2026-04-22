/**
 * Shared credential resolver for image-generation call sites.
 *
 * Consolidates the logic that was previously duplicated across the
 * image-studio tool, the CLI `image-generation` command, and the
 * app-icon generator. Each site picks between the managed-proxy path
 * (routes through the platform) and the "your own" path (direct
 * provider API key), and both paths need consistent, provider-aware
 * error hints when credentials are unavailable.
 */

import {
  buildManagedBaseUrl,
  resolveManagedProxyContext,
} from "../providers/managed-proxy/context.js";
import { getProviderKeyAsync } from "../security/secure-keys.js";
import type { ImageGenCredentials, ImageGenProvider } from "./types.js";

/**
 * Resolve credentials for an image-generation request.
 *
 * - `mode === "managed"`: returns managed-proxy credentials when the
 *   platform URL and assistant API key are both configured, otherwise
 *   returns a hint telling the user to log in or switch modes.
 * - `mode === "your-own"`: returns direct credentials when the provider
 *   API key is present in secure storage (or the env-var fallback),
 *   otherwise returns a provider-aware hint pointing at Settings.
 */
export async function resolveImageGenCredentials(opts: {
  provider: ImageGenProvider;
  mode: "managed" | "your-own";
}): Promise<{ credentials?: ImageGenCredentials; errorHint?: string }> {
  const { provider, mode } = opts;

  if (mode === "managed") {
    const baseUrl = await buildManagedBaseUrl(provider);
    if (!baseUrl) {
      return {
        errorHint:
          "Managed proxy is not available. Please log in to Vellum or switch to Your Own mode.",
      };
    }
    const ctx = await resolveManagedProxyContext();
    return {
      credentials: {
        type: "managed-proxy",
        assistantApiKey: ctx.assistantApiKey,
        baseUrl,
      },
    };
  }

  // mode === "your-own"
  const apiKey = await getProviderKeyAsync(provider);
  if (apiKey) {
    return { credentials: { type: "direct", apiKey } };
  }
  return { errorHint: providerKeyHint(provider) };
}

function providerKeyHint(provider: ImageGenProvider): string {
  switch (provider) {
    case "gemini":
      return "No Gemini API key configured. Please set your Gemini API key in Settings > Models & Services.";
    case "openai":
      return "No OpenAI API key configured. Please set your OpenAI API key in Settings > Models & Services.";
  }
}

/**
 * Shared credential resolver for image-generation call sites (image-studio
 * tool, CLI `image-generation` command, app-icon generator).
 *
 * Each call site picks between the managed-proxy path (routes through the
 * platform) and the "your own" path (direct provider API key). This module
 * resolves either path and returns a provider-aware error hint when
 * credentials are unavailable.
 */

import { PLATFORM_PROVIDER_META } from "../providers/platform-proxy/constants.js";
import { resolveManagedProxyContext } from "../providers/platform-proxy/context.js";
import { getProviderKeyAsync } from "../security/secure-keys.js";
import type { ImageGenCredentials, ImageGenProvider } from "./types.js";
import { providerForImageModelPrefix, providerForModel } from "./types.js";

/**
 * Resolve which backend serves an image request and whether it runs managed.
 *
 * `vellum` is unconditionally managed and carries no backend of its own: the
 * backend derives from the model prefix (`gpt-*`/`dall-e-*` proxy OpenAI,
 * anything else proxies Gemini), so one managed provider spans both runtime
 * proxies. Managed routing never falls back to a stored BYOK key, and a BYOK
 * provider never falls back to the proxy — billing follows the explicit
 * provider choice. Other providers use the caller's key, with an explicit
 * model override re-routing to the model's backend.
 */
export function resolveImageGenRouting(
  svc: { provider: string; model: string },
  modelOverride?: unknown,
): { backendProvider: ImageGenProvider; managed: boolean } {
  const managed = svc.provider === "vellum";
  if (svc.provider === "vellum") {
    const model =
      typeof modelOverride === "string" && modelOverride
        ? modelOverride
        : svc.model;
    return { backendProvider: providerForImageModelPrefix(model), managed };
  }
  return {
    backendProvider: providerForModel(
      modelOverride,
      svc.provider as ImageGenProvider,
    ),
    managed,
  };
}

/**
 * Resolve credentials for an image-generation request.
 *
 * - `managed`: returns managed-proxy credentials when the platform URL and
 *   assistant API key are both configured, otherwise a hint telling the
 *   user to log in.
 * - otherwise: returns direct credentials when the provider API key is
 *   present in secure storage (or the env-var fallback), otherwise a
 *   provider-aware hint pointing at Settings.
 */
export async function resolveImageGenCredentials(opts: {
  provider: ImageGenProvider;
  managed: boolean;
}): Promise<{ credentials?: ImageGenCredentials; errorHint?: string }> {
  const { provider, managed } = opts;

  if (managed) {
    // Resolve platform URL + assistant API key from a single snapshot so
    // baseUrl and assistantApiKey can't diverge if the credential is cleared
    // between lookups.
    const meta = PLATFORM_PROVIDER_META[provider];
    const ctx = await resolveManagedProxyContext();
    if (
      !meta?.managed ||
      !meta.proxyPath ||
      !ctx.enabled ||
      !ctx.assistantApiKey
    ) {
      return {
        errorHint:
          "Managed proxy is not available. Please log in to Vellum or switch to Your Own mode.",
      };
    }
    return {
      credentials: {
        type: "managed-proxy",
        assistantApiKey: ctx.assistantApiKey,
        baseUrl: `${ctx.platformBaseUrl}${meta.proxyPath}`,
      },
    };
  }

  const apiKey = await getProviderKeyAsync(provider);
  if (apiKey) {
    return { credentials: { type: "direct", apiKey } };
  }
  return { errorHint: providerKeyHint(provider) };
}

function providerKeyHint(provider: ImageGenProvider): string {
  switch (provider) {
    case "gemini":
      return "No Gemini API key configured. Please set your Gemini API key in Settings → Models & Services.";
    case "openai":
      return "No OpenAI API key configured. Please set your OpenAI API key in Settings → Models & Services.";
  }
}

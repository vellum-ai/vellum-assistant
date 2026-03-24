import { getConfig } from "../config/loader.js";
import {
  buildManagedBaseUrl,
  resolveManagedProxyContext,
} from "../providers/managed-proxy/context.js";
import { getProviderKeyAsync } from "../security/secure-keys.js";
import { ConfigError, ProviderError } from "../util/errors.js";
import {
  generateImage,
  type ImageGenCredentials,
} from "./gemini-image-service.js";

export interface GenerateAvatarOptions {
  /** Pre-resolved credentials, bypassing local secure-key lookup.
   *  Used by the CLI which fetches credentials from the daemon. */
  credentials?: ImageGenCredentials;
}

export async function generateAvatar(
  prompt: string,
  options?: GenerateAvatarOptions,
): Promise<{ imageBase64: string; mimeType: string }> {
  const config = getConfig();
  const imageGenMode = config.services["image-generation"].mode;

  // Use caller-supplied credentials when available (CLI path),
  // otherwise resolve from local secure storage (daemon path).
  let credentials: ImageGenCredentials | undefined = options?.credentials;

  if (!credentials) {
    if (imageGenMode === "managed") {
      const managedBaseUrl = await buildManagedBaseUrl("gemini");
      if (managedBaseUrl) {
        const ctx = await resolveManagedProxyContext();
        credentials = {
          type: "managed-proxy",
          assistantApiKey: ctx.assistantApiKey,
          baseUrl: managedBaseUrl,
        };
      }
    } else {
      const geminiKey = await getProviderKeyAsync("gemini");
      if (geminiKey) {
        credentials = { type: "direct", apiKey: geminiKey };
      }
    }
  }

  if (!credentials) {
    const hint =
      imageGenMode === "managed"
        ? "Managed proxy is not available. Please log in to Vellum or switch to Your Own mode."
        : "Gemini API key is not configured. Please set your Gemini API key in Settings > Models & Services.";
    throw new ConfigError(hint);
  }

  const result = await generateImage(credentials, {
    prompt,
    mode: "generate",
    model: config.services["image-generation"].model,
  });

  const image = result.images[0];
  if (!image) {
    throw new ProviderError(
      "Gemini image generation returned no images.",
      "gemini",
    );
  }

  return {
    imageBase64: image.dataBase64,
    mimeType: image.mimeType,
  };
}

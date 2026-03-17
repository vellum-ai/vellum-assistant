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

export async function generateAvatar(
  prompt: string,
): Promise<{ imageBase64: string; mimeType: string }> {
  const config = getConfig();
  const imageGenMode = config.services["image-generation"].mode;

  // Resolve credentials strictly based on mode — no cross-mode fallbacks
  let credentials: ImageGenCredentials | undefined;

  if (imageGenMode === "managed") {
    const managedBaseUrl = await buildManagedBaseUrl("vertex");
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

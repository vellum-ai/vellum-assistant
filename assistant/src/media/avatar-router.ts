import { getConfig } from "../config/loader.js";
import {
  buildManagedBaseUrl,
  resolveManagedProxyContext,
} from "../providers/managed-proxy/context.js";
import { ConfigError, ProviderError } from "../util/errors.js";
import {
  generateImage,
  type ImageGenCredentials,
} from "./gemini-image-service.js";

export async function generateAvatar(
  prompt: string,
): Promise<{ imageBase64: string; mimeType: string }> {
  const config = getConfig();
  const geminiKey = config.apiKeys.gemini ?? process.env.GEMINI_API_KEY;

  let credentials: ImageGenCredentials | undefined;
  if (geminiKey) {
    credentials = { type: "direct", apiKey: geminiKey };
  } else {
    const managedBaseUrl = buildManagedBaseUrl("vertex");
    if (managedBaseUrl) {
      const ctx = resolveManagedProxyContext();
      credentials = {
        type: "managed-proxy",
        assistantApiKey: ctx.assistantApiKey,
        baseUrl: managedBaseUrl,
      };
    }
  }

  if (!credentials) {
    throw new ConfigError(
      "Gemini API key is not configured. Set it via `keys set gemini <key>` or the GEMINI_API_KEY environment variable.",
    );
  }

  const result = await generateImage(credentials, {
    prompt,
    mode: "generate",
    model: config.imageGenModel,
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

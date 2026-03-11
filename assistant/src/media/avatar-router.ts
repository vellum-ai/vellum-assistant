import { getConfig } from "../config/loader.js";
import { ConfigError, ProviderError } from "../util/errors.js";
import { generateImage } from "./gemini-image-service.js";

export async function generateAvatar(
  prompt: string,
): Promise<{ imageBase64: string; mimeType: string }> {
  const config = getConfig();
  const geminiKey = config.apiKeys.gemini ?? process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    throw new ConfigError(
      "Gemini API key is not configured. Set it via `config set apiKeys.gemini <key>` or the GEMINI_API_KEY environment variable.",
    );
  }

  const result = await generateImage(geminiKey, {
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

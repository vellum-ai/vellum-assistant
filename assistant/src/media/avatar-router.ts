import { getConfig } from "../config/loader.js";
import { ConfigError, ProviderError } from "../util/errors.js";
import { resolveImageGenCredentials } from "./image-credentials.js";
import { generateImage, mapImageGenError } from "./image-service.js";

export async function generateAvatar(
  prompt: string,
): Promise<{ imageBase64: string; mimeType: string }> {
  const config = getConfig();
  const svc = config.services["image-generation"];

  const { credentials, errorHint } = await resolveImageGenCredentials({
    provider: svc.provider,
    mode: svc.mode,
  });

  if (!credentials) {
    throw new ConfigError(errorHint ?? "Image generation is not configured.");
  }

  let result;
  try {
    result = await generateImage(svc.provider, credentials, {
      prompt,
      mode: "generate",
      model: svc.model,
    });
  } catch (error) {
    // Re-throw with a provider-aware, user-friendly message so callers
    // (e.g. avatar-generator) don't need provider context to surface a
    // useful error.
    throw new ProviderError(
      mapImageGenError(svc.provider, error),
      svc.provider,
    );
  }

  const image = result.images[0];
  if (!image) {
    throw new ProviderError(
      "Image generation returned no images.",
      svc.provider,
    );
  }

  return {
    imageBase64: image.dataBase64,
    mimeType: image.mimeType,
  };
}

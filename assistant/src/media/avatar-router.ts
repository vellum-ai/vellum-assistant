import { getConfig } from "../config/loader.js";
import { ConfigError, ProviderError } from "../util/errors.js";
import {
  resolveImageGenCredentials,
  resolveImageGenRouting,
} from "./image-credentials.js";
import { generateImage, mapImageGenError } from "./image-service.js";

export async function generateAvatar(
  prompt: string,
): Promise<{ imageBase64: string; mimeType: string }> {
  const config = getConfig();
  const svc = config.services["image-generation"];

  const { backendProvider, managed } = resolveImageGenRouting(svc);
  const { credentials, errorHint } = await resolveImageGenCredentials({
    provider: backendProvider,
    managed,
  });

  if (!credentials) {
    throw new ConfigError(errorHint ?? "Image generation is not configured.");
  }

  let result;
  try {
    result = await generateImage(backendProvider, credentials, {
      prompt,
      mode: "generate",
      model: svc.model,
    });
  } catch (error) {
    // Re-throw with a provider-aware, user-friendly message so callers
    // (e.g. avatar-generator) don't need provider context to surface a
    // useful error.
    throw new ProviderError(
      mapImageGenError(backendProvider, error),
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

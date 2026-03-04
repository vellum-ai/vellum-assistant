/**
 * Strategy router for avatar generation.
 * Selects managed platform or local Gemini path based on config.
 */

import { getConfig } from "../config/loader.js";
import { ConfigError, ProviderError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import type {
  AvatarGenerationResult,
  AvatarGenerationStrategy,
} from "./avatar-types.js";
import { generateImage } from "./gemini-image-service.js";
import {
  generateManagedAvatar,
  isManagedAvailable,
} from "./managed-avatar-client.js";

const log = getLogger("avatar-router");

export function getAvatarStrategy(): AvatarGenerationStrategy {
  return getConfig().avatar.generationStrategy;
}

async function generateLocal(
  prompt: string,
  correlationId?: string,
): Promise<AvatarGenerationResult> {
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
      "Local Gemini image generation returned no images.",
      "gemini",
    );
  }

  return {
    imageBase64: image.dataBase64,
    mimeType: image.mimeType,
    pathUsed: "local",
    correlationId,
  };
}

export async function routedGenerateAvatar(
  prompt: string,
  options?: { correlationId?: string },
): Promise<AvatarGenerationResult> {
  const strategy = getAvatarStrategy();
  const correlationId = options?.correlationId;

  if (strategy === "managed_required") {
    const managed = await generateManagedAvatar(prompt, { correlationId });
    return {
      imageBase64: managed.image.data_base64,
      mimeType: managed.image.mime_type,
      pathUsed: "managed",
      correlationId: managed.correlation_id,
    };
  }

  if (strategy === "local_only") {
    return generateLocal(prompt, correlationId);
  }

  // managed_prefer: try managed first if available, fall back to local
  if (isManagedAvailable()) {
    try {
      const managed = await generateManagedAvatar(prompt, { correlationId });
      return {
        imageBase64: managed.image.data_base64,
        mimeType: managed.image.mime_type,
        pathUsed: "managed",
        correlationId: managed.correlation_id,
      };
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Managed avatar generation failed, falling back to local Gemini",
      );
    }
  }

  return generateLocal(prompt, correlationId);
}

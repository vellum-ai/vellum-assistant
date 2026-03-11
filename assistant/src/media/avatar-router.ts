/**
 * Avatar generation router.
 * Tries managed platform path if available, falls back to local Gemini.
 */

import { getConfig } from "../config/loader.js";
import { ConfigError, ProviderError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import type { AvatarGenerationResult } from "./avatar-types.js";
import { generateImage } from "./gemini-image-service.js";
import {
  generateManagedAvatar,
  isManagedAvailable,
} from "./managed-avatar-client.js";

const log = getLogger("avatar-router");

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
  options?: { correlationId?: string; model?: string },
): Promise<AvatarGenerationResult> {
  const correlationId = options?.correlationId;
  const model = options?.model;

  // Try managed platform path if available, fall back to local Gemini
  if (isManagedAvailable()) {
    try {
      const managed = await generateManagedAvatar(prompt, {
        correlationId,
        model,
      });
      return {
        imageBase64: managed.image.data_base64,
        mimeType: managed.image.mime_type,
        pathUsed: "managed",
        correlationId: managed.correlation_id,
        model,
      };
    } catch (err) {
      const config = getConfig();
      const geminiKey = config.apiKeys.gemini ?? process.env.GEMINI_API_KEY;
      if (!geminiKey) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "Managed avatar generation failed and no local Gemini key configured; re-throwing",
        );
        throw err;
      }
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Managed avatar generation failed, falling back to local Gemini",
      );
    }
  }

  return generateLocal(prompt, correlationId);
}

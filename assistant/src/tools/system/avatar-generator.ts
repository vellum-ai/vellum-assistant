import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { generateAvatar } from "../../media/avatar-router.js";
import { mapGeminiError } from "../../media/gemini-image-service.js";
import { getLogger } from "../../util/logger.js";
import { getAvatarImagePath } from "../../util/platform.js";

const log = getLogger("avatar-generator");

/** Canonical path where the custom avatar PNG is stored. */
function getAvatarPath(): string {
  return getAvatarImagePath();
}

export interface AvatarGenerationResult {
  content: string;
  isError: boolean;
}

/**
 * Generate a custom avatar image from a text description and save it
 * as the assistant's avatar PNG.
 *
 * Used by the HTTP route handler at POST /v1/settings/avatar/generate.
 */
export async function generateAndSaveAvatar(
  description: string,
): Promise<AvatarGenerationResult> {
  if (typeof description !== "string" || description.trim() === "") {
    return {
      content: "Error: description is required and must be a non-empty string.",
      isError: true,
    };
  }

  try {
    log.info({ description: description.trim() }, "Generating avatar");

    const prompt =
      `Create an avatar image based on this description: ${description.trim()}\n\n` +
      "Style: cute, friendly, work-safe illustration. " +
      "Vibrant but soft colors. Simple and recognizable at small sizes (28px). " +
      "Circular or rounded composition filling the canvas. " +
      "Subtle background color (not white or transparent).";

    const result = await generateAvatar(prompt);
    if (!result.imageBase64) {
      return {
        content: "Error: No image data returned. Please try again.",
        isError: true,
      };
    }
    const pngBuffer = Buffer.from(result.imageBase64, "base64");

    const avatarPath = getAvatarPath();
    const avatarDir = dirname(avatarPath);

    const tmpPath = `${avatarPath}.${randomUUID()}.tmp`;
    mkdirSync(avatarDir, { recursive: true });
    writeFileSync(tmpPath, pngBuffer);
    renameSync(tmpPath, avatarPath);

    log.info({ avatarPath }, "Avatar saved successfully");

    return {
      content: "Avatar updated! Your new avatar will appear shortly.",
      isError: false,
    };
  } catch (error) {
    const message = mapGeminiError(error);
    log.error({ error: message }, "Avatar generation failed");
    return {
      content: `Avatar generation failed: ${message}`,
      isError: true,
    };
  }
}

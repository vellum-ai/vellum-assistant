import { generateAvatar } from "../../media/avatar-router.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("avatar-generator");

export interface AvatarGenerationResult {
  /** On success, the generated PNG bytes. Null on error. */
  pngBuffer: Buffer | null;
  /** User-facing message describing success or the failure reason. */
  content: string;
  isError: boolean;
}

/**
 * Generate a custom avatar image from a text description and return the PNG
 * bytes. Persistence is the caller's responsibility — the route handler routes
 * the bytes through the avatar store (`setImage`) so the manifest and artifacts
 * stay consistent.
 *
 * Used by the HTTP route handler at POST /v1/settings/avatar/generate.
 */
export async function generateAvatarImage(
  description: string,
): Promise<AvatarGenerationResult> {
  if (typeof description !== "string" || description.trim() === "") {
    return {
      pngBuffer: null,
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
        pngBuffer: null,
        content: "Error: No image data returned. Please try again.",
        isError: true,
      };
    }
    const pngBuffer = Buffer.from(result.imageBase64, "base64");

    log.info("Avatar generated successfully");

    return {
      pngBuffer,
      content: "Avatar updated! Your new avatar will appear shortly.",
      isError: false,
    };
  } catch (error) {
    // avatar-router already throws with a provider-aware, user-friendly
    // message — just surface error.message directly.
    const message =
      error instanceof Error
        ? error.message
        : "An unexpected error occurred during image generation.";
    log.error({ error: message }, "Avatar generation failed");
    return {
      pngBuffer: null,
      content: `Avatar generation failed: ${message}`,
      isError: true,
    };
  }
}

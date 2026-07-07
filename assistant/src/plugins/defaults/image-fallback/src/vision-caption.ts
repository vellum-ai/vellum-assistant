/**
 * Vision-based image captioning for the image-fallback plugin.
 *
 * When the active model cannot process images, this module finds a
 * vision-capable profile in the workspace's configured profiles and runs a
 * one-shot captioning call through the assistant's own inference (no
 * plugin-supplied API key). The caption replaces the image block in the
 * outgoing message history.
 */

import {
  doesSupportVision,
  getConfiguredProvider,
  getModelProfiles,
  type ImageContent,
  type PluginLogger,
} from "@vellumai/plugin-api";

import {
  getCachedCaption,
  imageHash,
  setCachedCaption,
} from "./caption-cache.js";

const CAPTION_TIMEOUT_MS = 30_000;

const CAPTION_SYSTEM_PROMPT =
  "You are a vision assistant. Describe the image concisely in 1-2 sentences. " +
  "Focus on the key visual content, text, charts, or UI elements that would be " +
  "relevant for a text-based assistant to understand and reason about.";

const CAPTION_USER_PROMPT =
  "Describe this image concisely for a text-only assistant.";

/**
 * Find a vision-capable, enabled profile key for captioning.
 *
 * Scans the workspace's profiles in `getModelProfiles()` order (the same order
 * the `/model` picker shows them) and returns the first enabled profile whose
 * resolved model supports vision. Returns `null` when no vision profile exists
 * — the hook fails-open in that case, leaving a placeholder text block.
 */
export function findVisionProfile(): string | null {
  for (const profile of getModelProfiles()) {
    if (profile.isDisabled) continue;
    if (doesSupportVision(profile)) {
      return profile.key;
    }
  }
  return null;
}

/**
 * Caption a single image block via a vision-capable profile.
 *
 * @param image     The image content block to caption.
 * @param profileKey  Key of a vision-capable profile (from {@link findVisionProfile}).
 * @param logger    Turn-scoped logger for attribution.
 * @returns The caption text, or `null` when captioning failed (caller should
 *          use a fail-open placeholder).
 */
export async function captionImage(
  image: ImageContent,
  profileKey: string,
  logger: PluginLogger,
): Promise<string | null> {
  // Reference-source images have no inline bytes here; their attachment id is a
  // stable cache key. The provider resolves the bytes when the block is sent.
  const hash =
    image.source.type === "base64"
      ? imageHash(image.source.data)
      : image.source.attachmentId;
  const cached = getCachedCaption(hash);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const provider = await getConfiguredProvider("vision", {
      overrideProfile: profileKey,
      forceOverrideProfile: true,
    });
    if (!provider) {
      logger.warn(
        { plugin: "image-fallback" },
        "No provider resolved for vision captioning profile",
      );
      return null;
    }

    const response = await provider.sendMessage(
      [
        {
          role: "user",
          content: [image, { type: "text", text: CAPTION_USER_PROMPT }],
        },
      ],
      {
        systemPrompt: CAPTION_SYSTEM_PROMPT,
        config: {
          callSite: "vision",
          overrideProfile: profileKey,
          forceOverrideProfile: true,
          tool_choice: { type: "none" },
        },
        signal: AbortSignal.timeout(CAPTION_TIMEOUT_MS),
      },
    );

    // Vision captioning returns text content; concatenate any text blocks
    // (effectively always one here, since tool use is disabled).
    const caption = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join(" ")
      .trim();
    if (caption.length > 0) {
      setCachedCaption(hash, caption);
      return caption;
    }

    logger.warn(
      { plugin: "image-fallback" },
      "Vision captioning returned empty text",
    );
    return null;
  } catch (err) {
    logger.warn(
      { plugin: "image-fallback", err },
      "Vision captioning call failed",
    );
    return null;
  }
}

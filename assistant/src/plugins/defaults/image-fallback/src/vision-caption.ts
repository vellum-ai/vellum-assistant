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
  getProfileInputTokenPrice,
  type ImageContent,
  type PluginLogger,
  resolveMediaSourceData,
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
 * Find a vision-capable, enabled profile key for captioning, preferring the
 * cheapest.
 *
 * Collects every enabled profile whose resolved model supports vision, in
 * `getModelProfiles()` order (the order the `/model` picker shows them), then
 * returns the one with the lowest resolved input-token price. Any vision model
 * captions a 1-2 sentence description adequately, so cost is the tiebreak.
 * Profiles the catalog can't price rank after all priced ones, and equal prices
 * keep picker order — so a single vision profile, or a set with no known
 * pricing, is returned exactly as picker order presents it. Returns `null` when
 * no vision profile exists — the hook fails-open in that case, leaving a
 * placeholder text block.
 */
export function findVisionProfile(): string | null {
  const visionProfileKeys: string[] = [];
  for (const profile of getModelProfiles()) {
    if (profile.isDisabled) {
      continue;
    }
    if (doesSupportVision(profile)) {
      visionProfileKeys.push(profile.key);
    }
  }
  return cheapestByInputPrice(visionProfileKeys);
}

/**
 * Pick the cheapest profile key by resolved input-token price. `profileKeys`
 * arrives in picker order; unknown-price profiles rank after every priced
 * profile and, along with equal-priced ones, keep that incoming order. A list
 * of zero or one key is returned without pricing any profile, so single-profile
 * selection stays identical to picker order. Returns `null` for an empty list.
 */
function cheapestByInputPrice(profileKeys: string[]): string | null {
  if (profileKeys.length <= 1) {
    return profileKeys[0] ?? null;
  }
  const ranked = profileKeys
    .map((key, index) => ({
      key,
      index,
      // Unknown price sorts after every known price.
      price: getProfileInputTokenPrice(key) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) =>
      a.price !== b.price ? a.price - b.price : a.index - b.index,
    );
  return ranked[0].key;
}

/**
 * Caption a single image block via a vision-capable profile.
 *
 * @param image     The image content block to caption.
 * @param conversationId  Conversation the image belongs to, recorded on the
 *          cache row so `conversation-deleted` cleanup stays accurate.
 * @param profileKey  Key of a vision-capable profile (from {@link findVisionProfile}).
 * @param logger    Turn-scoped logger for attribution.
 * @returns The caption text, or `null` when captioning failed (caller should
 *          use a fail-open placeholder).
 */
export async function captionImage(
  image: ImageContent,
  conversationId: string,
  profileKey: string,
  logger: PluginLogger,
): Promise<string | null> {
  // Hash the image's content (resolving a reference source to its bytes, a
  // no-op for inline base64) so the caption cache keys on the image itself.
  const resolved = resolveMediaSourceData(image.source);
  if (!resolved) {
    return null;
  }
  const hash = imageHash(resolved.data);
  const cached = getCachedCaption(hash, conversationId);
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
          conversationId,
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
      setCachedCaption(hash, conversationId, caption);
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

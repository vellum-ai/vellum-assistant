/**
 * Shared image→text substitution for the image-fallback plugin's hooks.
 *
 * Two hooks replace `image` content blocks with a text caption when the turn's
 * model can't process images: `user-prompt-submit` handles user-attached
 * images, and `post-tool-use` handles images a tool returns (e.g. a browser
 * screenshot). This module holds what they share — deciding whether a profile
 * needs the fallback ({@link needsImageFallback}) and the per-block
 * substitution ({@link captionImageBlocks}): persist the original image to a
 * known location, caption it via a vision-capable profile, and swap in a
 * `[Image …]` text block.
 *
 * The substitution mutates the blocks in place, so the caption replaces the
 * image everywhere the block is referenced (the provider-bound history and the
 * persisted/displayed copy alike) — a text-only turn does not keep the raw
 * image around.
 *
 * The caption text states up front that the model can't view images and the
 * image was auto-described to text, so the model treats the block as a derived
 * description rather than a verbatim transcript.
 *
 * Fail-open is the dominant error mode: a captioning failure leaves a
 * placeholder text block rather than the raw image (which a text-only provider
 * would reject) or nothing (which would lose information).
 */

import {
  type ContentBlock,
  doesSupportVision,
  getModelProfiles,
  type ImageContent,
  type PluginLogger,
} from "@vellumai/plugin-api";

import { persistImage } from "./image-persist.js";
import { captionImage } from "./vision-caption.js";

/**
 * Whether the profile a turn runs needs image→text fallback (i.e. it can't
 * process images itself).
 *
 * Used by `user-prompt-submit`, whose context carries the effective profile
 * identity. Profileless configs use the resolved model id, which
 * `doesSupportVision` can check directly.
 */
export function needsImageFallback(modelProfileKey: string): boolean {
  const profiles = getModelProfiles();
  const profile = profiles.find((p) => p.key === modelProfileKey);
  if (profile == null) return !doesSupportVision(modelProfileKey);
  return !doesSupportVision(profile);
}

/**
 * Replace every `image` block in `blocks` (in place) with a text caption so a
 * text-only model can still reason about the image's content. Returns the
 * number of image blocks replaced.
 *
 * @param blocks            Content-block array to scan and mutate in place.
 * @param visionProfileKey  Key of a vision-capable profile for captioning, or
 *                          `null` when none is configured (fail-open
 *                          placeholder).
 * @param logger            Turn-scoped logger for attribution.
 */
export async function captionImageBlocks(
  blocks: ContentBlock[],
  visionProfileKey: string | null,
  logger: PluginLogger,
): Promise<number> {
  let imageCount = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type !== "image") continue;

    imageCount++;
    const image = block as ImageContent;

    // Persist the original to a known, content-hash-deduped location so it
    // survives the text substitution and stays findable on disk. Reference
    // sources already live durably in the attachment store, so there is
    // nothing to persist for them.
    if (image.source.type === "base64") {
      persistImage(image.source.data, image.source.media_type);
    }

    if (visionProfileKey != null) {
      const caption = await captionImage(image, visionProfileKey, logger);
      blocks[i] = {
        type: "text",
        text:
          caption != null
            ? `[Image auto-described for text-only model: ${caption}]`
            : `[Image: auto-description failed (text-only model)]`,
      };
    } else {
      // No vision profile configured at all — fail-open placeholder.
      blocks[i] = {
        type: "text",
        text: `[Image: no vision-capable model configured to describe it]`,
      };
    }
  }

  return imageCount;
}

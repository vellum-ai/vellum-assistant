/**
 * Configuration for the image-fallback plugin, which stands in for images the
 * turn's model cannot see.
 *
 * `captionMode` picks what the substituted text block carries:
 *
 * - `caption` (default) — a vision profile describes each image and the
 *   description goes into the transcript. The model reasons from the
 *   description without asking for anything, at the cost of one vision call
 *   per new image.
 * - `handle-only` — the block names the image and nothing else. Nothing is
 *   described up front, so a conversation full of images costs no vision
 *   calls; the model spends one only when it calls `image_ask` about an image
 *   it actually needs to see.
 *
 * The plugin reads this per sweep, so a change takes effect on the next turn
 * with no restart.
 */
import { z } from "zod";

/** Accepted `imageFallback.captionMode` values. */
export const CAPTION_MODES = ["caption", "handle-only"] as const;

export const ImageFallbackConfigSchema = z
  .object({
    captionMode: z
      .enum(CAPTION_MODES, {
        error: `imageFallback.captionMode must be one of: ${CAPTION_MODES.join(", ")}`,
      })
      .default("caption")
      .describe(
        "How an image is represented to a model that cannot see it: `caption` describes every image via a vision profile up front; `handle-only` names the image and leaves the looking to the `image_ask` tool.",
      ),
  })
  .describe("Image fallback behavior for text-only models");

export type ImageFallbackConfig = z.infer<typeof ImageFallbackConfigSchema>;
export type CaptionMode = ImageFallbackConfig["captionMode"];

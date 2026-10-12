/**
 * Anthropic's vision limits: the resolution tiers, the visual-token patch
 * images are priced in, and the per-image dimension cap on many-image
 * requests.
 *
 * Claude costs an image in visual tokens, one per 28 x 28 px patch, after
 * downscaling it to fit the model's tier: the largest aspect-preserving size
 * whose padded edges stay within the tier's edge limit and whose patch count
 * stays within its visual-token limit. Padding to the next patch boundary adds
 * nothing beyond that count.
 * https://platform.claude.com/docs/en/build-with-claude/vision#evaluate-image-size
 * https://platform.claude.com/docs/en/build-with-claude/vision-coordinates#how-claude-resizes-and-pads-images
 */

import { claudeModelGeneration } from "./model-ids.js";

const VISUAL_TOKEN_PATCH_PX = 28;

export interface VisionTier {
  /** Longest padded side an image may keep, in pixels. */
  readonly maxEdgePx: number;
  /** Visual tokens an image may cost after downscaling. */
  readonly maxVisualTokens: number;
}

/**
 * Tier of Claude models before 4.7, and the estimate applied to providers
 * without their own image pricing.
 */
export const STANDARD_VISION_TIER: VisionTier = {
  maxEdgePx: 1568,
  maxVisualTokens: 1568,
};

/** Tier of Claude 4.7 and later; the API applies it with no opt-in. */
export const HIGH_RESOLUTION_VISION_TIER: VisionTier = {
  maxEdgePx: 2576,
  maxVisualTokens: 4784,
};

const HIGH_RESOLUTION_MIN_GENERATION = { major: 4, minor: 7 };

/**
 * A request carrying more than 20 image blocks, counting every turn's images
 * and those nested in tool results, is rejected unless each image stays within
 * this many pixels on both sides.
 * https://platform.claude.com/docs/en/build-with-claude/vision#request-limits
 */
export const MANY_IMAGE_MAX_DIMENSION_PX = 2000;

/**
 * The tier a model views images at. Claude 4.7 and later are on the
 * high-resolution tier whichever provider serves them; every other model id,
 * and an unknown model, is costed on the standard tier.
 */
export function visionTierForModel(model: string | undefined): VisionTier {
  if (model === undefined) {
    return STANDARD_VISION_TIER;
  }
  const generation = claudeModelGeneration(model);
  if (generation === null) {
    return STANDARD_VISION_TIER;
  }
  const { major, minor } = HIGH_RESOLUTION_MIN_GENERATION;
  const highResolution =
    generation.major > major ||
    (generation.major === major && generation.minor >= minor);
  return highResolution ? HIGH_RESOLUTION_VISION_TIER : STANDARD_VISION_TIER;
}

export interface ImageSize {
  width: number;
  height: number;
}

/** Visual tokens of an image at this size: one per 28 x 28 px patch. */
export function countVisualTokens(width: number, height: number): number {
  return (
    Math.ceil(width / VISUAL_TOKEN_PATCH_PX) *
    Math.ceil(height / VISUAL_TOKEN_PATCH_PX)
  );
}

/**
 * Round half to even, as the API does when it sizes the short edge: rounding
 * halves up would compute a different size for some images.
 */
function roundTiesToEven(value: number): number {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) {
    return Math.round(value);
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * The size Claude downscales an image to on `tier` before padding: the largest
 * aspect-preserving size that fits the tier's edge and visual-token limits,
 * found by binary search along the long edge. An image that already fits is
 * returned unchanged. Mirrors the reference implementation in Anthropic's
 * docs.
 */
export function resizedImageSize(
  width: number,
  height: number,
  tier: VisionTier,
): ImageSize {
  const fits = (w: number, h: number): boolean =>
    Math.ceil(w / VISUAL_TOKEN_PATCH_PX) * VISUAL_TOKEN_PATCH_PX <=
      tier.maxEdgePx &&
    Math.ceil(h / VISUAL_TOKEN_PATCH_PX) * VISUAL_TOKEN_PATCH_PX <=
      tier.maxEdgePx &&
    countVisualTokens(w, h) <= tier.maxVisualTokens;

  if (fits(width, height)) {
    return { width, height };
  }
  if (height > width) {
    const rotated = resizedImageSize(height, width, tier);
    return { width: rotated.height, height: rotated.width };
  }

  const aspectRatio = width / height;
  const shortEdge = (longEdge: number): number =>
    Math.max(roundTiesToEven(longEdge / aspectRatio), 1);
  let lo = 1;
  let hi = width;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, shortEdge(mid))) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return { width: lo, height: shortEdge(lo) };
}

/**
 * Visual tokens an image of this size costs on `tier`, after the downscale
 * Claude applies. A size that is not a pair of positive finite numbers costs
 * the tier's maximum, the ceiling used when dimensions are unknown.
 */
export function estimateVisualTokens(
  width: number,
  height: number,
  tier: VisionTier,
): number {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return tier.maxVisualTokens;
  }
  const resized = resizedImageSize(width, height, tier);
  return countVisualTokens(resized.width, resized.height);
}

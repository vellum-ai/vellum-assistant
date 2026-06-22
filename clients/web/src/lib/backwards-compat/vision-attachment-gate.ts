/**
 * Backwards-compat gate: vision attachment filtering.
 *
 * Vellum Assistant dev build `0.10.0-dev.202606211252.5cf8576` is the
 * first version with the image-fallback plugin that handles image
 * captioning server-side, so the web client no longer needs to
 * pre-filter images for non-vision models — all file types can be
 * attached to any model.
 *
 * Assistants on 0.10.0 stable or older have no image-fallback plugin.
 * The drop/pick handler still filters out images when the active model
 * lacks vision support, preserving the old behavior.
 *
 * The MIN_VERSION is the exact dev version string. The backwards compat
 * system treats dev pre-releases as ahead of the stable release with
 * the same base, and compares two dev builds by their timestamp — so
 * this build and any newer dev build or future stable release (0.10.1+)
 * will light up the feature.
 */
import { useAssistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.10.0-dev.202606211252.5cf8576";

/**
 * Returns `true` when the web client should filter image attachments
 * for non-vision models. Active for assistants older than 0.10.0;
 * inactive for 0.10.0+ (including dev pre-releases).
 */
export function useVisionAttachmentGate(): boolean {
  return !useAssistantSupports(MIN_VERSION);
}

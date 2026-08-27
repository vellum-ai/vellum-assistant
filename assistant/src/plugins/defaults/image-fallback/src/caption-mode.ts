/**
 * Resolution of `imageFallback.captionMode` for the caption sweep.
 *
 * `caption` describes every image the model cannot see, so the description is
 * already in the transcript when the model reasons about it. `handle-only`
 * leaves a named placeholder and no description, so nothing is spent until
 * the model calls `image_ask` about an image it actually needs.
 *
 * Read per sweep off the read-only config accessor (never the writing one — a
 * turn must not rewrite the config file), so a setting change lands on the
 * next turn. Fails to the shipped `caption` default when the config cannot be
 * read, which keeps the behavior a workspace already has.
 */

import { getConfigReadOnly } from "../../../../config/loader.js";
import type { CaptionMode } from "../../../../config/schemas/image-fallback.js";

export function getCaptionMode(): CaptionMode {
  try {
    return getConfigReadOnly().imageFallback.captionMode;
  } catch {
    return "caption";
  }
}

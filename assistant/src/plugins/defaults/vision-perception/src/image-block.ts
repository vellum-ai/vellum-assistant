/**
 * Shared helper for wrapping optimized image bytes into a provider
 * {@link ImageContent} block.
 */

import type { ImageContent } from "../../../../providers/types.js";

/**
 * Wrap an {@link optimizeImageForTransport} result (`{ data, mediaType }`) into
 * a base64 {@link ImageContent} block. Shared by the image and video-frame
 * resolvers so the provider block shape has a single source.
 */
export function toImageBlock(optimized: {
  data: string;
  mediaType: string;
}): ImageContent {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: optimized.mediaType,
      data: optimized.data,
    },
  };
}

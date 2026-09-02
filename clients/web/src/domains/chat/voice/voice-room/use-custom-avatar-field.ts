/**
 * The room-fill color for an assistant whose avatar is an uploaded image.
 *
 * A character avatar carries its color as data, so the room can paint itself
 * the moment the avatar query settles. An uploaded image carries pixels, so the
 * color has to be sampled out of it (see `utils/avatar-image-color.ts`), which
 * is async and can fail. This hook wraps that: null until a sample resolves,
 * null forever if it cannot, and the caller keeps its colorless fallback in
 * both cases rather than blocking the room's first paint on a decode.
 *
 * Results are cached by URL for the session, including failures, so returning
 * to a room does not re-decode the image and a broken one is not retried on
 * every mount. The URLs are per-assistant blob URLs minted by the avatar query,
 * so the cache key is stable for as long as the avatar is.
 */

import { useEffect, useState } from "react";

import { sampleAvatarFieldHex } from "@/utils/avatar-image-color";

/** Sampled field color per image URL. A cached `null` is a known failure. */
const sampled = new Map<string, string | null>();

/** Reset the session cache. Tests only. */
export function clearCustomAvatarFieldCache(): void {
  sampled.clear();
}

/**
 * Field color sampled from `customImageUrl`, or null while it resolves, when
 * there is no custom image, or when the image cannot be read.
 */
export function useCustomAvatarFieldHex(
  customImageUrl: string | null,
): string | null {
  const [hex, setHex] = useState<string | null>(() =>
    customImageUrl ? (sampled.get(customImageUrl) ?? null) : null,
  );

  useEffect(() => {
    if (!customImageUrl) {
      setHex(null);
      return;
    }
    // `has` rather than a truthy check: a cached null is a resolved failure and
    // must not queue the decode again.
    if (sampled.has(customImageUrl)) {
      setHex(sampled.get(customImageUrl) ?? null);
      return;
    }
    // Any color held here belongs to a different image, and the surfaces
    // reading it would paint that one until this decode lands. Null is what
    // they already handle as "no color yet".
    setHex(null);
    let cancelled = false;
    void sampleAvatarFieldHex(customImageUrl).then((next) => {
      sampled.set(customImageUrl, next);
      if (!cancelled) {
        setHex(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [customImageUrl]);

  return hex;
}

/**
 * The accent of an uploaded avatar image, sampled in the browser.
 *
 * The daemon reads an uploaded image's accent out of its pixels and serves it
 * with the avatar manifest, so on a current assistant nothing here runs. An
 * assistant that predates accents serves none, and the voice surfaces that
 * paint themselves the assistant's colour would go dark for an uploaded
 * avatar, so this samples the same colour out of the image on the client
 * (see `utils/avatar-image-color.ts`, which runs the same maths the daemon
 * does). Async and fallible: null until a sample resolves, null forever if it
 * cannot, and the caller keeps its colourless fallback in both cases rather
 * than blocking its first paint on a decode.
 *
 * Results are cached by URL for the session, including failures, so returning
 * to a room does not re-decode the image and a broken one is not retried on
 * every mount. The URLs are per-assistant blob URLs minted by the avatar query,
 * so the cache key is stable for as long as the avatar is.
 *
 * Delete this once every supported assistant serves an accent.
 */

import { useEffect, useState } from "react";

import { sampleAvatarAccentHex } from "@/utils/avatar-image-color";

/** Sampled accent per image URL. A cached `null` is a known failure. */
const sampled = new Map<string, string | null>();

/** Reset the session cache. Tests only. */
export function clearSampledAvatarAccentCache(): void {
  sampled.clear();
}

/**
 * Accent sampled from `customImageUrl`, or null while it resolves, when
 * there is no image to sample, or when the image cannot be read. Pass null
 * whenever the daemon already served an accent.
 */
export function useSampledAvatarAccentHex(
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
    void sampleAvatarAccentHex(customImageUrl).then((next) => {
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

/**
 * Encoding the assistant avatar small enough to travel inside an iOS Live
 * Activity's `ActivityAttributes`.
 *
 * ## Why bytes, and why so few
 *
 * A Live Activity view renders from a snapshot in the widget extension's
 * process. There is no async image loading there (`AsyncImage` only ever
 * draws its placeholder), so an avatar cannot be handed over as a URL for the
 * extension to fetch. It has to arrive already decoded, which means the bytes
 * travel with the activity.
 *
 * ActivityKit caps how much can travel: `Activity.request` throws
 * `ActivityAuthorizationError.attributesTooLarge` past a ceiling that is much
 * lower in practice than the 4KB Apple documents. See
 * {@link ISLAND_AVATAR_MAX_BYTES} for what was actually measured, and leave the
 * assistant name, phase label, accent hex and mute flag room to grow without
 * the avatar being what pushes the activity over.
 *
 * Going over is not a degraded avatar, it is **no Live Activity at all**: the
 * request throws and the island never appears. That asymmetry is why
 * {@link encodeAvatarForIsland} returns null rather than its smallest attempt
 * when nothing fits: an island with a waveform glyph is fine, and an island
 * that failed to start is not.
 *
 * ## Why a ladder rather than one size
 *
 * The two avatar kinds compress nothing alike, and neither compresses as well
 * as it looks like it should. Rather than pick a lowest common denominator,
 * try candidates from best to worst and take the first that fits. See
 * {@link CANDIDATES} for the measured sizes the ladder is built around.
 */

import { rasterizeAvatar } from "@/utils/avatar-raster";
import type { AvatarRender } from "@/utils/avatar-render";

/**
 * Byte ceiling for the encoded avatar.
 *
 * **Measured, not derived.** Apple documents ActivityKit's limit as 4KB across
 * attributes plus content state, but that is not the number that works: on an
 * iPhone 17 Pro simulator (iOS 26.5), a 3366-byte avatar threw
 * `attributesTooLarge` and produced no Live Activity at all, while 1997 bytes
 * rendered. The effective ceiling is therefore somewhere between the two, well
 * under what the documentation implies, presumably because ActivityKit's own
 * archiving counts against the same budget.
 *
 * 2000 is the value that was verified end to end. Re-measure before raising
 * it, on a device or simulator, by watching whether the island appears at all:
 * there is no error to observe, because the whole activity is what fails.
 */
export const ISLAND_AVATAR_MAX_BYTES = 2000;

/**
 * Encoding attempts, best first.
 *
 * Sizes step down further than seems necessary because the avatar compresses
 * far worse than a flat-color character suggests: measured for the default
 * character avatar, 128px PNG is 6860 bytes, 96px is 5010, 64px is 3366, 48px
 * is 2419, and only 40px lands under budget at 1997. The anti-aliased edges of
 * the composited shapes, not the number of colors, are what cost.
 *
 * PNG rungs come first and go all the way down because they keep the avatar's
 * transparency. JPEG is smaller per pixel but has no alpha, so
 * {@link rasterizeAvatar} mattes it onto white, which reads as a white disc
 * against the black Dynamic Island. It is a real fallback for photographic
 * uploads, which PNG cannot fit at any useful size, but never a first choice.
 */
const CANDIDATES: ReadonlyArray<{
  size: number;
  type: "image/png" | "image/jpeg";
  quality?: number;
}> = [
  { size: 128, type: "image/png" },
  { size: 96, type: "image/png" },
  { size: 64, type: "image/png" },
  { size: 48, type: "image/png" },
  { size: 40, type: "image/png" },
  { size: 32, type: "image/png" },
  { size: 64, type: "image/jpeg", quality: 0.7 },
  { size: 48, type: "image/jpeg", quality: 0.6 },
];

/** Base64 for bytes, without a data-URI prefix: the bridge carries the payload raw. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Rasterize `render` as small as it needs to be to fit `maxBytes`, returning
 * base64 or null.
 *
 * Null means "show the accent glyph instead", and is the right answer for a
 * `none` avatar, a source that fails to draw, and an avatar that will not fit
 * at any rung. Every caller must treat it as ordinary rather than as an error:
 * the Live Activity is a flourish, and none of these cases should cost the
 * user their island.
 */
export async function encodeAvatarForIsland(
  render: AvatarRender,
  maxBytes: number = ISLAND_AVATAR_MAX_BYTES,
  // Injected rather than mocked at the module boundary: `mock.module` replaces
  // the whole of `avatar-raster`, which silently strips `coverCropSquare` from
  // every test file that shares the process.
  rasterize: typeof rasterizeAvatar = rasterizeAvatar,
): Promise<string | null> {
  if (render.kind === "none") {
    return null;
  }
  const src = render.kind === "character" ? render.dataUri : render.url;

  for (const candidate of CANDIDATES) {
    let bytes: Uint8Array | null;
    try {
      bytes = await rasterize(
        src,
        candidate.size,
        candidate.type,
        candidate.quality,
      );
    } catch {
      // The source itself will not draw (a revoked blob URL, a cross-origin
      // upload). No later rung can fix that, so stop rather than retry it
      // five more times.
      return null;
    }
    if (bytes && bytes.byteLength <= maxBytes) {
      return toBase64(bytes);
    }
  }
  return null;
}

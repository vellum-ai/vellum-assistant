/**
 * Encoding the assistant avatar small enough to travel inside an iOS Live
 * Activity's `ActivityAttributes`.
 *
 * ## Why bytes, and why so few
 *
 * A Live Activity view renders from a snapshot in the widget extension's
 * process. There is no async image loading there — `AsyncImage` only ever
 * draws its placeholder — so an avatar cannot be handed over as a URL for the
 * extension to fetch. It has to arrive already decoded, which means the bytes
 * travel with the activity.
 *
 * ActivityKit caps how much can travel: `Activity.request` throws
 * `ActivityAuthorizationError.attributesTooLarge`, and Apple documents the
 * ceiling as 4KB for the attributes and content state *combined*.
 * {@link ISLAND_AVATAR_MAX_BYTES} therefore claims well under half of that,
 * leaving the assistant name, phase label, accent hex and mute flag room to
 * grow without the avatar being what pushes the activity over.
 *
 * Going over is not a degraded avatar, it is **no Live Activity at all** — the
 * request throws and the island never appears. That asymmetry is why
 * {@link encodeAvatarForIsland} returns null rather than its smallest attempt
 * when nothing fits: an island with a waveform glyph is fine, and an island
 * that failed to start is not.
 *
 * ## Why a ladder rather than one size
 *
 * The two avatar kinds compress nothing alike. A character avatar is a handful
 * of flat colors and shrinks to almost nothing as PNG, so it can afford real
 * resolution. A photographic upload does not, and needs JPEG and a smaller
 * square to fit at all. Rather than pick a lowest common denominator that
 * makes character avatars needlessly soft, try candidates from best to worst
 * and take the first that fits.
 */

import { rasterizeAvatar } from "@/utils/avatar-raster";
import type { AvatarRender } from "@/utils/avatar-render";

/**
 * Byte ceiling for the encoded avatar.
 *
 * Apple documents ActivityKit's limit as 4KB across attributes plus content
 * state. This claims 1.5KB of that, which leaves well over half for everything
 * else and absorbs the overhead of however ActivityKit archives the payload —
 * a detail that is not contractual, so the headroom is deliberate rather than
 * calculated.
 */
export const ISLAND_AVATAR_MAX_BYTES = 1536;

/**
 * Encoding attempts, best first. Character avatars are expected to land on the
 * first or second; photographic uploads fall through to the JPEG rungs.
 */
const CANDIDATES: ReadonlyArray<{
  size: number;
  type: "image/png" | "image/jpeg";
  quality?: number;
}> = [
  { size: 128, type: "image/png" },
  { size: 96, type: "image/png" },
  { size: 64, type: "image/png" },
  { size: 96, type: "image/jpeg", quality: 0.75 },
  { size: 64, type: "image/jpeg", quality: 0.7 },
  { size: 48, type: "image/jpeg", quality: 0.6 },
];

/** Base64 for bytes, without a data-URI prefix — the bridge carries the payload raw. */
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
): Promise<string | null> {
  if (render.kind === "none") {
    return null;
  }
  const src = render.kind === "character" ? render.dataUri : render.url;

  for (const candidate of CANDIDATES) {
    let bytes: Uint8Array | null;
    try {
      bytes = await rasterizeAvatar(
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

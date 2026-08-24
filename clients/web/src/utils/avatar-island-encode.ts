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
 *
 * ## Why the Home Screen widgets are here too
 *
 * The widget snapshot rasterizes the same avatar from the same source through
 * the same ladder, differing only in the budget it can afford (an App Group
 * write rather than an ActivityKit attribute). Both surfaces therefore share
 * {@link memoizedAvatarEncode}, so a session pays the canvas draw once per
 * avatar however many of them ask for it, and the caching rules live in one
 * place rather than being restated per consumer.
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

/**
 * One memoized encode: the bytes for an avatar at a budget, plus the work still
 * in flight when this is the first read since that avatar changed.
 */
export interface AvatarEncodeMemo {
  /**
   * Distinguishes one encode from the next. A caller that keys a payload on the
   * avatar can carry this instead of the bytes, which are tens of kilobytes at
   * a widget's budget and would otherwise be re-serialized on every render.
   */
  revision: number;
  /**
   * The encoded bytes, or null both while {@link pending} is unsettled and when
   * there is legitimately nothing to send (no avatar, or nothing fit).
   */
  base64: string | null;
  /** The encode still running, or null when there is nothing to wait for. */
  pending: Promise<string | null> | null;
}

/** An {@link AvatarEncodeMemo} with the source it is cached against. */
interface AvatarEncodeSlot extends AvatarEncodeMemo {
  source: AvatarRender;
}

/**
 * The last encode per byte budget, each slot holding the source it came from.
 *
 * Module scope, so the canvas draw is paid once per avatar however many native
 * surfaces ask for it and however often they re-render. The key inside a slot
 * is the resolved {@link AvatarRender}, a stable object recomputed only when
 * the avatar itself changes, so identity comparison is enough and there is
 * nothing to invalidate.
 *
 * Kept per budget rather than one slot for every caller, because the ceilings
 * come from unrelated limits (ActivityKit's attribute budget against an App
 * Group write). Serving a widget-sized encode to a Live Activity is not a
 * larger avatar, it is no island at all.
 */
const encodeSlots = new Map<number, AvatarEncodeSlot>();
let encodeRevisions = 0;

/**
 * The encoded avatar for `render` at `maxBytes`, starting the encode if this is
 * the first read since the avatar changed.
 *
 * A `none` avatar resolves without touching the encoder, so a caller with
 * nothing to draw stays synchronous with whatever triggered it.
 *
 * An encode that RESOLVES null is cached: no avatar, and an avatar that fit no
 * rung, are both stable facts about the source. An encode that THROWS is not
 * cached, and its slot is dropped so the next read starts over. The failure is
 * the encoder rather than the avatar (a canvas the shell would not hand over, a
 * blob URL revoked mid-draw), and caching it would leave every later payload in
 * the session avatar-less. Either way this read still resolves null: a surface
 * is worth more than the face on it.
 */
export function memoizedAvatarEncode(
  render: AvatarRender,
  maxBytes: number = ISLAND_AVATAR_MAX_BYTES,
  // Injected for the same reason `rasterize` is above: tests reach the encoder
  // without `mock.module` replacing this module for every file in the process.
  encode: typeof encodeAvatarForIsland = encodeAvatarForIsland,
): AvatarEncodeMemo {
  const cached = encodeSlots.get(maxBytes);
  if (cached !== undefined && cached.source === render) {
    return cached;
  }
  encodeRevisions += 1;
  const slot: AvatarEncodeSlot = {
    source: render,
    revision: encodeRevisions,
    base64: null,
    pending: null,
  };
  encodeSlots.set(maxBytes, slot);
  if (render.kind === "none") {
    return slot;
  }
  slot.pending = encode(render, maxBytes).then(
    (base64) => {
      slot.base64 = base64;
      slot.pending = null;
      return base64;
    },
    () => {
      // Dropped only while it is still the current slot: a newer avatar has
      // its own encode running, and evicting that would restart it.
      if (encodeSlots.get(maxBytes) === slot) {
        encodeSlots.delete(maxBytes);
      }
      slot.pending = null;
      return null;
    },
  );
  return slot;
}

/**
 * Drop every memoized encode. Not intended for production callers: the cache is
 * module scope, so tests sharing a process would otherwise inherit each other's
 * slots and revisions.
 */
export function __resetAvatarEncodeMemoForTesting(): void {
  encodeSlots.clear();
  encodeRevisions = 0;
}

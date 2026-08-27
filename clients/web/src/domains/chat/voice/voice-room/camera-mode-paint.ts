/**
 * The paint camera mode wears: the accents its chrome is toned with, the fills
 * its control row is told apart by, and the two scrims that keep both legible
 * over the feed.
 *
 * Fixed values rather than theme tokens, deliberately. What sits behind this
 * chrome is an arbitrary live camera image, not a surface the app painted, so
 * a token like `--content-default` is as likely to vanish into the frame as to
 * read on it, and flipping the chrome with the app theme would restyle it for a
 * background that never changed. Same reasoning as the room's `--room-*`
 * contract in `voice-surface-paint.ts` next door, and the STYLE_GUIDE's
 * carve-out for values that must not vary by theme.
 *
 * The accents ship as scoped `--camera-*` custom properties (see
 * {@link cameraModeStyle}) so every piece of camera chrome reads one contract
 * instead of importing the hex itself. They are NOT new global token ramps: the
 * scope is the camera, and nothing outside it should be able to reach them. The
 * scrims are plain background values, since a gradient layer has nothing to
 * hand down.
 */

import type { CSSProperties } from "react";

/**
 * Crimson: the capture accent, worn by the chrome that is actively sampling.
 * Published as `--camera-accent`; its softened half is what reads on the small
 * marks, which is why the two ship as a pair.
 */
export const CAMERA_ACCENT = "#cf4370";

/**
 * Rose: the accent at the size of a 5px dot. The crimson goes muddy that small
 * over video, so the status dot takes this instead while the assistant speaks.
 */
export const CAMERA_ACCENT_SOFT = "#ffd9e4";

/**
 * The warm brown the camera's own controls are filled with: flip beside the
 * shutter, and the toggle that closes the viewfinder.
 *
 * A third hue in a row that otherwise has only two, and that is the point. The
 * row already spends white on "the session is live" and red on "this changes
 * the call", so a control that does neither cannot borrow either without
 * saying something untrue. Warm rather than more glass because over a feed a
 * translucent black button is the one that vanishes into a dark frame.
 *
 * The stronger of the pair goes to a toggle that is engaged: the camera control
 * is held down for as long as the viewfinder is up, and sits a shade heavier
 * than the resting controls beside it.
 */
export const CAMERA_WARM = "rgba(90,74,64,.75)";
export const CAMERA_WARM_STRONG = "rgba(90,74,64,.8)";

/**
 * The red a control acting on the call wears over the feed: the mutes while
 * engaged, and end-session always.
 *
 * Solid, not the translucent red the room's other surfaces use. The chrome here
 * sits on arbitrary video, and a 55%-opacity red over a red jumper is a button
 * with no edges; the whole row is filled for the same reason.
 */
export const CAMERA_DESTRUCTIVE = "#e8453f";

/**
 * Legibility scrims for the top and bottom bands of the feed, where all the
 * camera chrome lives. Only those two bands carry a tint, so the middle of the
 * frame (the part the user is actually aiming at) stays untouched.
 */
export const CAMERA_SCRIM_TOP = "linear-gradient(rgba(0,0,0,.42), transparent)";
export const CAMERA_SCRIM_BOTTOM =
  "linear-gradient(transparent, rgba(0,0,0,.46))";

/**
 * The `--camera-*` vars as an inline style, for the element that owns a piece
 * of camera chrome. Mirrors the `voiceSurfaceStyle` pattern next door.
 */
export function cameraModeStyle(): CSSProperties {
  return {
    "--camera-accent": CAMERA_ACCENT,
    "--camera-accent-soft": CAMERA_ACCENT_SOFT,
    "--camera-warm": CAMERA_WARM,
    "--camera-warm-strong": CAMERA_WARM_STRONG,
    "--camera-destructive": CAMERA_DESTRUCTIVE,
  } as CSSProperties;
}

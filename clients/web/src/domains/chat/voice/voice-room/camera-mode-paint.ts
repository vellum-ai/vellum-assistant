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
 *
 * The glass treatments ship as class strings for the same reason the colors
 * ship as vars: the design gives three different pieces of chrome three
 * different fills, and a literal written at each call site is a fill that
 * drifts the first time one of them is retuned. Each value lives here once and
 * every consumer names it.
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
 * The crimson at the weight a whole surface can be filled with: the capture
 * accent at 90%, so a status mark painted in it still lets a little of the
 * frame through and reads as chrome over video rather than a sticker on it.
 * Published as `--camera-accent-fill`.
 */
export const CAMERA_ACCENT_FILL = "rgba(207,67,112,.9)";

/**
 * The ink a glyph takes on a fill bright enough to lose a white one: the mic
 * while the session is live, and the flash while it is armed. Near-black rather
 * than pure, matching the weight the rest of the room's dark text carries.
 * Published as `--camera-ink`.
 */
export const CAMERA_INK = "#1a1a1a";

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
 * The status pill's glass: the design's own fill and hairline, under the blur
 * that keeps it honest over a bright frame. Its own values rather than the
 * over-media glass below, because the pill is a readout rather than a target
 * and sits lighter than the controls it shares a screen with.
 */
export const CAMERA_PILL_GLASS_CLASS =
  "border-[0.5px] border-[rgba(255,255,255,0.18)] bg-[rgba(0,0,0,0.34)] text-[rgba(255,255,255,0.88)] backdrop-blur-[8px]";

/**
 * The same pill while the camera is streaming rather than sampling: filled with
 * the capture accent, so "this is going out live" is legible as a change in
 * color from across the screen. The border firms up and the text goes to pure
 * white, since a crimson fill takes more contrast than the glass does.
 */
export const CAMERA_PILL_LIVE_CLASS =
  "border-[0.5px] border-[rgba(255,255,255,0.25)] bg-[var(--camera-accent-fill)] text-white backdrop-blur-[8px]";

/**
 * The flash control at rest, which the design draws heavier than the pill and
 * behind a firmer hairline: it is a target rather than a readout, and it has to
 * hold an edge beside the near-white it cycles into.
 */
export const CAMERA_FLASH_GLASS_CLASS =
  "border-white/20 bg-black/42 text-white backdrop-blur-sm";

/**
 * The scrim any mark sitting directly on live video takes: the room's corner
 * chrome once the viewfinder is up, the deep-link overlay's controls, and the
 * camera's own failure message. The blur is what keeps it readable over a busy
 * frame without pushing the fill toward opaque.
 */
export const CAMERA_MEDIA_GLASS_CLASS =
  "bg-black/45 text-white backdrop-blur-sm";

/**
 * The `--camera-*` vars as an inline style, for the element that owns a piece
 * of camera chrome. Mirrors the `voiceSurfaceStyle` pattern next door.
 */
export function cameraModeStyle(): CSSProperties {
  return {
    "--camera-accent": CAMERA_ACCENT,
    "--camera-accent-soft": CAMERA_ACCENT_SOFT,
    "--camera-accent-fill": CAMERA_ACCENT_FILL,
    "--camera-ink": CAMERA_INK,
    "--camera-warm": CAMERA_WARM,
    "--camera-warm-strong": CAMERA_WARM_STRONG,
    "--camera-destructive": CAMERA_DESTRUCTIVE,
  } as CSSProperties;
}

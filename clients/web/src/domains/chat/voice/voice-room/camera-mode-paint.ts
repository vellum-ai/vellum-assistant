/**
 * The paint camera-mode chrome wears: the accent that marks Live capture, the
 * assistant-speaking dot, the warm tone the flip and camera-off controls take,
 * and the two scrims that keep the top and bottom rows legible.
 *
 * These are deliberately not theme tokens. Camera chrome is drawn over an
 * arbitrary live camera image, so a token that resolves per app theme says
 * nothing about what is behind the pixel: `--content-default` is as likely to
 * vanish into the frame as to read on it. The colors ship as scoped
 * `--camera-*` vars instead, the same contract and the same reasoning as the
 * `--room-*` vars in `voice-surface-paint.ts`, and covered by the style guide's
 * carve-out for color that should not vary by theme.
 */

import type { CSSProperties } from "react";

/** Live-mode accent: the crimson shutter core and the capture pulse. */
export const CAMERA_ACCENT = "#cf4370";
/** The softer rose of the assistant-speaking dot in the status pill. */
export const CAMERA_ACCENT_SOFT = "#ffd9e4";
/** Warm neutral for the flip control. */
export const CAMERA_WARM = "rgba(90,74,64,0.75)";
/** The same warm neutral, held a touch heavier for the camera-off control. */
export const CAMERA_WARM_STRONG = "rgba(90,74,64,0.8)";

/** Top scrim: darkens the frame under the status pill. */
export const CAMERA_SCRIM_TOP = "linear-gradient(rgba(0,0,0,.42), transparent)";
/** Bottom scrim: darkens the frame under the shutter and control row. */
export const CAMERA_SCRIM_BOTTOM =
  "linear-gradient(transparent, rgba(0,0,0,.46))";

/**
 * The `--camera-*` vars as an inline style. Put it on the container the camera
 * chrome mounts in so descendants can read the accent without importing it.
 */
export function cameraModeStyle(): CSSProperties {
  return {
    "--camera-accent": CAMERA_ACCENT,
    "--camera-accent-soft": CAMERA_ACCENT_SOFT,
    "--camera-warm": CAMERA_WARM,
    "--camera-warm-strong": CAMERA_WARM_STRONG,
  } as CSSProperties;
}

/**
 * The line above the shutter naming what a press does and what a hold does.
 *
 * A hold is the one gesture on this surface nothing else can announce. The
 * shutter looks the same whether or not it takes one, the pill reports the mode
 * after the fact rather than the way into it, and a viewfinder is exactly where
 * a user will not go hunting for a second act on a button they already know.
 * So the caption is the affordance, and it is shown only where the hold is
 * actually offered: a hint for a gesture that would do nothing is worse than no
 * hint at all.
 *
 * Both states are one line in the same place. The mode word is on the left
 * either way, so the eye reads the change rather than a caption arriving and
 * leaving, and the accent it takes while live is the same crimson the ring and
 * the pill wear.
 *
 * `aria-hidden`, like the pill beside it: the room's always-mounted live region
 * speaks the mode, and a caption repeating it would be the second voice saying
 * the same thing. The hold itself is advertised on the shutter through
 * `aria-keyshortcuts`.
 *
 * Presentational. The room decides whether Live is on offer and which mode is
 * running; nothing here reaches for a store.
 */

import { cn } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

import { cameraModeStyle } from "./camera-mode-paint";
import type { CameraMode } from "./camera-status-pill";

/** The line per mode: what the shutter offers now, and how to leave. */
const HINT_KEYS = {
  photo: "cameraShutterHint.photo",
  live: "cameraShutterHint.live",
} as const;

export interface CameraShutterHintProps {
  /** What the camera is doing. Defaults to `photo`, the resting state. */
  mode?: CameraMode;
}

export function CameraShutterHint({ mode = "photo" }: CameraShutterHintProps) {
  const { t } = useTranslation("chat");

  return (
    <p
      aria-hidden
      data-testid="camera-shutter-hint"
      data-camera-mode={mode}
      style={cameraModeStyle()}
      className={cn(
        // The pill's own type, tracked out and uppercased in CSS so the
        // catalogs carry sentence case and a locale that does not uppercase
        // is not asked to.
        "text-label-medium-default uppercase tracking-[0.18em]",
        "[--text-label-medium-default-weight:600]",
        mode === "live" ? "text-[var(--camera-accent)]" : "text-white/70",
      )}
    >
      {t(HINT_KEYS[mode])}
    </p>
  );
}

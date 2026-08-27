/**
 * The shutter button both camera surfaces press: the voice room's in-call
 * viewfinder and the deep-link capture overlay.
 *
 * One component rather than two copies because the two are the same control
 * doing the same job, and the look is load-bearing in a way that has to stay
 * consistent. A ring around a core, at the size the platform's own camera uses,
 * so it is the one thing on the surface nobody has to be taught.
 *
 * White, with no fill of its own. Both surfaces darken the band the shutter
 * sits in, so legibility over a bright frame is the scrim's job rather than the
 * button's: a dark backing here answers a question already answered, and dulls
 * the one control that is supposed to be the brightest thing on the screen.
 *
 * `mode` is the sampling policy the press acts on. `live` is built and
 * exercised by the stories and the suite but is not reachable in the app, where
 * the capture path is photo-only. It belongs to this component's contract
 * rather than to whichever caller reaches it first.
 *
 * Presentational, with one exception. The caller owns what a press does, what
 * counts as busy, and the label, so nothing here reaches for a store or the
 * camera. The press FEEDBACK is the component's, because that is the part no
 * caller can see: a photo leaves the viewfinder unchanged, so without the pulse
 * a successful capture and a dead button look identical. Leftover props land on
 * the button, which is what lets a `Tooltip` wrap it.
 */

import type { ComponentProps, MouseEvent } from "react";
import { useState } from "react";

import { cn } from "@vellumai/design-library";
import { useReducedMotion } from "motion/react";

import { cameraModeStyle } from "@/domains/chat/voice/voice-room/camera-mode-paint";

/** Which sampling policy the press acts on. See the module docstring. */
export type CameraShutterMode = "photo" | "live";

export interface CameraShutterProps extends Omit<
  ComponentProps<"button">,
  "aria-label" | "children"
> {
  /** Accessible name. The two surfaces phrase the shot differently. */
  ariaLabel: string;
  /**
   * `photo` takes one frame per press; `live` is streaming, and the press
   * stops it. Photo is the resting state, so it is the default.
   */
  mode?: CameraShutterMode;
  /**
   * The frame is being captured or uploaded. Dips the core, which is the whole
   * signal: the ring holds its size so the target under the user's thumb never
   * moves between one shot and the next.
   */
  capturing?: boolean;
  testId?: string;
}

export function CameraShutter({
  ariaLabel,
  mode = "photo",
  capturing = false,
  disabled = false,
  testId,
  className,
  onClick,
  style,
  ...buttonProps
}: CameraShutterProps) {
  const reduce = useReducedMotion();
  // Bumped per press so the pulse remounts and its keyframe restarts. A CSS
  // animation cannot be replayed by toggling a class within one frame, and the
  // presses this has to answer come as fast as a thumb can tap.
  const [pulses, setPulses] = useState(0);
  const live = mode === "live";

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Live's press stops the stream, which the ring's own morph back to white
    // already reports. A capture pulse there would announce a frame nobody
    // took.
    if (!live) {
      setPulses((count) => count + 1);
    }
    onClick?.(event);
  };

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={testId}
      data-mode={mode}
      onClick={handleClick}
      style={{ ...cameraModeStyle(), ...style }}
      className={cn(
        // Border-box: the design's 84 is the outer measure, ring included, so
        // the core's gap inside it is what the border eats into.
        "camera-shutter relative box-border flex size-[84px] items-center justify-center rounded-full border-[2.5px]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white",
        live ? "border-[var(--camera-accent)]" : "border-white",
        disabled ? "opacity-60" : "hover:opacity-90",
        reduce && "camera-shutter-calm",
        className,
      )}
      {...buttonProps}
    >
      {/* Nothing to render until the first press: the keyframe starts from a
          shadow the ring does not otherwise have, so mounting it at rest would
          fire a capture pulse for a photo nobody took.

          Inset out to the ring's OUTER edge, so the pulse leaves the shutter's
          own circle rather than starting 2.5px inside it. */}
      {pulses > 0 ? (
        <span
          key={pulses}
          aria-hidden
          data-testid="camera-shutter-pulse"
          className="camera-shutter-pulse pointer-events-none absolute -inset-[2.5px] rounded-full"
        />
      ) : null}

      <span
        data-testid="camera-shutter-core"
        className={cn(
          "camera-shutter-core size-16 rounded-full",
          live
            ? "scale-[0.58] bg-[var(--camera-accent)]"
            : "scale-100 bg-white",
          capturing && "opacity-70",
        )}
      />
    </button>
  );
}

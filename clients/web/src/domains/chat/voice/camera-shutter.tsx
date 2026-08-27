/**
 * The shutter button both camera surfaces press: the voice room's in-call
 * viewfinder and the deep-link capture overlay.
 *
 * One component rather than two copies because the two are the same control
 * doing the same job, and the look is load-bearing in a way that has to stay
 * consistent. Video is the only thing a shutter is ever seen against, and the
 * frame can be any brightness, so white alone is not enough: a white ring on a
 * white wall is as invisible as a dark one on a dark shirt. The white sits on a
 * dark fill and a dark outer hairline, so one edge or the other separates it
 * from the video at both extremes.
 *
 * Presentational only. The caller owns what a press does, what counts as busy,
 * and the label, so nothing here reaches for a store or the camera. Leftover
 * props land on the button, which is what lets a `Tooltip` wrap it.
 */

import type { ComponentProps } from "react";

import { cn } from "@vellumai/design-library";

export interface CameraShutterProps extends Omit<
  ComponentProps<"button">,
  "aria-label" | "children"
> {
  /** Accessible name. The two surfaces phrase the shot differently. */
  ariaLabel: string;
  /**
   * The frame is being captured or uploaded. Shrinks the inner disc: the
   * shutter's own press animation doubling as the progress signal, so nothing
   * else has to appear over the viewfinder.
   */
  capturing?: boolean;
  testId?: string;
}

export function CameraShutter({
  ariaLabel,
  capturing = false,
  disabled = false,
  testId,
  className,
  ...buttonProps
}: CameraShutterProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn(
        "flex size-16 items-center justify-center rounded-full border-4 transition",
        "border-white bg-black/30 shadow-[0_0_0_1.5px_rgba(0,0,0,0.4)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white",
        disabled ? "opacity-60" : "hover:bg-black/45",
        className,
      )}
      {...buttonProps}
    >
      <span
        className={cn(
          "rounded-full bg-white transition-all",
          capturing ? "size-6" : "size-11",
        )}
      />
    </button>
  );
}

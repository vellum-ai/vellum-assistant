/**
 * The voice room's flash control: one button cycling off, auto, on.
 *
 * A cycle rather than a menu because there are three states and the control is
 * pressed with one thumb while the other hand holds the phone at whatever it is
 * pointed at. A menu would cost a press to open, a reach to pick, and would
 * cover the frame the user is aiming.
 *
 * Off is dark glass, matching the chrome around it. Auto and on go inverted,
 * near-white with a dark glyph, so "the flash will fire" is legible as a change
 * in weight from across the screen rather than as a difference between two
 * outlines, and auto adds the badge that says which of the two it is.
 *
 * A bespoke glyph rather than a lucide icon: the set has a bolt, but not a
 * slashed one, and not one that carries a badge. It snaps to lucide in all
 * three of the things that make an icon read as one of a set: the 24-unit
 * viewBox it is drawn on, the 2-unit stroke it is drawn with, and the 20px it
 * renders at, which is the size every other glyph in the control row takes.
 *
 * Presentational only. The caller owns the mode, what a press does, and the
 * accessible name. Leftover props land on the button, which is what lets a
 * `Tooltip` wrap it.
 */

import type { ComponentProps } from "react";

import { cn } from "@vellumai/design-library";

import type { FlashMode } from "@/stores/voice-prefs-store";

import { CAMERA_FLASH_GLASS_CLASS, cameraModeStyle } from "./camera-mode-paint";

/** The order a press moves through. Off is the resting state, so it closes the loop. */
const FLASH_CYCLE: Record<FlashMode, FlashMode> = {
  off: "auto",
  auto: "on",
  on: "off",
};

/** The mode a press on `current` selects. */
export function nextFlashMode(current: FlashMode): FlashMode {
  return FLASH_CYCLE[current];
}

export interface CameraFlashControlProps extends Omit<
  ComponentProps<"button">,
  "aria-label" | "children"
> {
  mode: FlashMode;
  /** Accessible name, which has to say the state and not the act. */
  ariaLabel: string;
  /**
   * The one-character mark that tells auto from on, drawn into the corner of
   * the glyph. Passed in rather than baked in because it is a letter, and the
   * letter that abbreviates "automatic" is not the same one everywhere.
   */
  autoBadge: string;
  testId?: string;
}

export function CameraFlashControl({
  mode,
  ariaLabel,
  autoBadge,
  testId,
  className,
  ...buttonProps
}: CameraFlashControlProps) {
  const armed = mode !== "off";

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      data-testid={testId}
      data-flash-mode={mode}
      // The control sits in the shutter's row rather than in the room's own,
      // which is the element that publishes the camera contract, so it carries
      // the vars its armed ink reads.
      style={cameraModeStyle()}
      className={cn(
        // Border-box with a border in every state, transparent when the state
        // has no visible one, so the three states measure identically and the
        // glyph does not shift by a pixel as they cycle.
        "relative box-border flex size-[46px] items-center justify-center rounded-full border",
        "transition-colors duration-[250ms]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white",
        // The visual circle is under the 48pt minimum a thumb needs, and
        // growing it would crowd the shutter. The target grows instead.
        "after:absolute after:-inset-1 after:content-['']",
        // Fixed colors, not theme tokens, for the same reason the chrome
        // around it uses them: what sits behind this is arbitrary camera
        // video, so there is no surface for a token to describe.
        armed
          ? "border-transparent bg-white/92 text-[var(--camera-ink)]"
          : CAMERA_FLASH_GLASS_CLASS,
        className,
      )}
      {...buttonProps}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-5"
        aria-hidden
      >
        <path d="M13 2 L4.5 13.5 H11 l-1 8.5 L18.5 10.5 H12 z" />
        {mode === "off" ? <path d="M3.5 20.5 L20.5 3.5" /> : null}
      </svg>
      {/* Hidden from assistive tech: the accessible name already says "auto"
          in words, and a lone letter read out after it says nothing more. */}
      {mode === "auto" ? (
        <span
          aria-hidden
          className="absolute right-[12px] bottom-[10px] text-[8px] leading-none font-bold"
        >
          {autoBadge}
        </span>
      ) : null}
    </button>
  );
}

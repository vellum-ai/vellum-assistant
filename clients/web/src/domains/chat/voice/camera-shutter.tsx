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
 * `mode` is the sampling policy the press acts on: a tap takes one photo, and a
 * tap while live stops the stream.
 *
 * The HOLD is the component's too, where a caller offers one. A hold and the
 * tap it ends with are one press to the browser and two acts to the user, and
 * only the element taking the press can tell them apart in time; a caller
 * watching its own state change would be racing a render against the click
 * that follows the release. So the threshold, the cancels, and the suppression
 * of the tap a fired hold ends with all live here, and the caller is handed
 * one `onHold` that has already happened.
 *
 * Presentational, with one exception. The caller owns what a press does, what
 * counts as busy, and the label, so nothing here reaches for a store or the
 * camera. The press FEEDBACK is the component's, because that is the part no
 * caller can see: a photo leaves the viewfinder unchanged, so without the pulse
 * a successful capture and a dead button look identical. Leftover props land on
 * the button, which is what lets a `Tooltip` wrap it.
 */

import type {
  ComponentProps,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
} from "react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@vellumai/design-library";
import { useReducedMotion } from "motion/react";

import { cameraModeStyle } from "@/domains/chat/voice/voice-room/camera-mode-paint";
import { haptic } from "@/utils/haptics";

/** Which sampling policy the press acts on. See the module docstring. */
export type CameraShutterMode = "photo" | "live";

/**
 * How long the shutter is held before it counts as a hold, and how far the
 * pointer may wander first.
 *
 * The platform's own long-press numbers, matching `use-long-press.ts` value for
 * value. That hook owns the touch-only surface gesture and cannot be reused
 * here (this arms on pointers, so a mouse can hold too, and it has a tap of its
 * own to suppress), so the constants are restated rather than shared: two
 * different thresholds for "held" in one app is a hold that feels wrong on
 * whichever surface lost the coin toss.
 */
const HOLD_THRESHOLD_MS = 500;
const HOLD_MOVE_TOLERANCE_PX = 10;

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
  /**
   * A press held past the threshold, if the caller offers a second act on the
   * shutter. Left out, the gesture layer is inert and the shutter is the plain
   * tap target it has always been.
   */
  onHold?: () => void;
  testId?: string;
}

export function CameraShutter({
  ariaLabel,
  mode = "photo",
  capturing = false,
  disabled = false,
  onHold,
  testId,
  className,
  onClick,
  style,
  // Composed rather than spread over, because `buttonProps` lands after these
  // on the element: a `Tooltip` wrapping this reaches it through Radix's slot
  // and brings pointer handlers of its own, and letting either side win
  // silently would cost the other one its behavior.
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onKeyDown,
  onKeyUp,
  ...buttonProps
}: CameraShutterProps) {
  const reduce = useReducedMotion();
  // Bumped per press so the pulse remounts and its keyframe restarts. A CSS
  // animation cannot be replayed by toggling a class within one frame, and the
  // presses this has to answer come as fast as a thumb can tap.
  const [pulses, setPulses] = useState(0);
  const live = mode === "live";

  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdOriginRef = useRef<{ x: number; y: number } | null>(null);
  /**
   * A hold has fired and the press that follows is its release.
   *
   * A ref rather than state, and read in `handleClick` rather than by the
   * caller, because the release's `click` arrives in the same task as the
   * `pointerup` before it. Anything that has to re-render first (a mode prop
   * coming back down, a piece of state here) is not settled by the time the
   * click needs answering, so the hold would also fire the tap it ended with.
   */
  const heldRef = useRef(false);

  const clearHoldTimer = () => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const cancelHold = () => {
    clearHoldTimer();
    holdOriginRef.current = null;
  };

  /**
   * A new press begins, so whatever the last one was is over.
   *
   * The flag is normally consumed by the click a fired hold ends with, but the
   * keyboard path produces no click to consume it (the activation was
   * suspended on the way down), and a caller that withdraws `onHold` once the
   * hold has done its work leaves nothing else to clear it. Cleared here
   * instead of on release, so a stray click still finds it raised while a
   * later press never does.
   */
  const beginPress = () => {
    heldRef.current = false;
  };

  const armHold = () => {
    clearHoldTimer();
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      holdOriginRef.current = null;
      heldRef.current = true;
      void haptic.light();
      onHold?.();
    }, HOLD_THRESHOLD_MS);
  };

  // The press can outlive the button: the room can close the camera under a
  // finger that is still down, and a timer left running would fire into an
  // unmounted tree.
  useEffect(() => {
    return () => {
      if (holdTimerRef.current !== null) {
        clearTimeout(holdTimerRef.current);
      }
    };
  }, []);

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // The release of a fired hold. It is one press, and the hold already acted
    // on it, so nothing here may run: not the caller's tap, and not the pulse,
    // which would announce a photo the hold did not take.
    if (heldRef.current) {
      heldRef.current = false;
      return;
    }
    // Live's press stops the stream, which the ring's own morph back to white
    // already reports. A capture pulse there would announce a frame nobody
    // took.
    if (!live) {
      setPulses((count) => count + 1);
    }
    onClick?.(event);
  };

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    onPointerDown?.(event);
    beginPress();
    if (!onHold || disabled) {
      return;
    }
    // A right-click is a menu, not a hold, and its button is never released
    // over this element to cancel one.
    if (event.button !== 0) {
      return;
    }
    // Nothing is prevented here and nothing is captured. On iOS, cancelling
    // `pointerdown` (or `touchstart`) drops the whole compatibility sequence
    // including the `click` this control is built on (docs/CAPACITOR.md), and
    // pointer capture retargets that click to whoever holds it, which for a
    // press on a control is the control losing its own tap.
    holdOriginRef.current = { x: event.clientX, y: event.clientY };
    armHold();
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    onPointerMove?.(event);
    const origin = holdOriginRef.current;
    if (!origin) {
      return;
    }
    // A finger that has travelled is aiming somewhere else, and a shutter held
    // at arm's length drifts on its own; the tolerance is what separates the
    // two.
    if (
      Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >
      HOLD_MOVE_TOLERANCE_PX
    ) {
      cancelHold();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event);
    if (event.repeat) {
      return;
    }
    beginPress();
    if (!onHold || disabled) {
      return;
    }
    // Enter stays a plain tap: the browser fires its click on the way down, so
    // there is no press to hold. Space activates on release, which is what
    // leaves room for a threshold between the two.
    if (event.key !== " ") {
      return;
    }
    // Taking the default is what suspends the button's own Space activation,
    // so the release can decide whether this press was a tap. A press that
    // turns out to be one re-dispatches the click below.
    event.preventDefault();
    armHold();
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    onKeyUp?.(event);
    if (!onHold || event.key !== " ") {
      return;
    }
    const tapped = holdTimerRef.current !== null;
    const button = event.currentTarget;
    cancelHold();
    if (tapped) {
      button.click();
    }
  };

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      // Advertised rather than left to be discovered: a hold is invisible to a
      // screen reader, which has no hint above the shutter to read.
      // eslint-disable-next-line local/no-untranslated-strings -- ARIA key name, not copy: assistive tech speaks the key in the user's language from this token
      aria-keyshortcuts={onHold ? "Space" : undefined}
      data-testid={testId}
      data-mode={mode}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => {
        onPointerUp?.(event);
        cancelHold();
      }}
      onPointerCancel={(event) => {
        onPointerCancel?.(event);
        cancelHold();
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event);
        cancelHold();
      }}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      style={{ ...cameraModeStyle(), ...style }}
      className={cn(
        // Border-box: the design's 84 is the outer measure, ring included, so
        // the core's gap inside it is what the border eats into.
        "camera-shutter relative box-border flex size-[84px] items-center justify-center rounded-full border-[2.5px]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white",
        // What a held press must not turn into. iOS raises its selection
        // callout on a long touch, which races the threshold and lands a
        // system menu over the viewfinder, and a browser that claims the
        // gesture as a pan cancels the pointer stream before the hold fires.
        "select-none [-webkit-touch-callout:none] [touch-action:none]",
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

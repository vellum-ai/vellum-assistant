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
 * one `onHold` that has already happened. The presses that end without a
 * release to end them (a wandering finger, focus moving off the button, a
 * blurred window, a backgrounded page, a hold the caller takes back) are the
 * same job, and are given up on here for the same reason. What a hold is worth in time and travel is not
 * this component's to decide: both numbers come from `use-long-press.ts`, so
 * the app has one answer to "how long is held".
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
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { cn } from "@vellumai/design-library";
import { useReducedMotion } from "motion/react";

import { cameraModeStyle } from "@/domains/chat/voice/voice-room/camera-mode-paint";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import {
  LONG_PRESS_MOVE_TOLERANCE_PX,
  LONG_PRESS_THRESHOLD_MS,
} from "@/hooks/use-long-press";
import { haptic } from "@/utils/haptics";

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
  /**
   * A press held past the threshold, if the caller offers a second act on the
   * shutter. Left out, the gesture layer is inert and the shutter is the plain
   * tap target it has always been.
   */
  onHold?: () => void;
  /**
   * One sentence naming what the label cannot: the gesture that starts the
   * second act, or the one that ends it.
   *
   * Attached as the button's accessible description, which is the only route
   * assistive tech has to it. The caption a caller draws above the shutter is
   * `aria-hidden`, being a second voice for something already spoken, and
   * `aria-keyshortcuts` names a key without naming what it does. Left out, the
   * button is described by nothing, which is right for a shutter whose only
   * act is the one its label already names.
   */
  description?: string;
  testId?: string;
}

export function CameraShutter({
  ariaLabel,
  mode = "photo",
  capturing = false,
  disabled = false,
  onHold,
  description,
  testId,
  className,
  onClick,
  style,
  // Composed rather than spread over, because `buttonProps` lands after these
  // on the element: a `Tooltip` wrapping this reaches it through Radix's slot
  // and brings pointer handlers of its own, and a description of its own while
  // it is open, and letting either side win silently would cost the other one
  // its behavior.
  "aria-describedby": callerDescribedBy,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onBlur,
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
  // Whether a press can become a hold at all. Presence rather than the function
  // itself, because the callers build a new one every render and nothing here
  // is about which one is on offer.
  const holdOffered = onHold !== undefined;
  // Joined rather than replaced: a `Tooltip` describes its trigger with its own
  // content while it is open, and the gesture is the half a screen reader has
  // no other way to learn.
  const descriptionId = useId();
  const describedBy =
    [description ? descriptionId : null, callerDescribedBy]
      .filter(Boolean)
      .join(" ") || undefined;

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
  /**
   * A press was given up on partway through, so its release is not a tap.
   *
   * `cancelHold` only stops the threshold, which is all a press that ends off
   * the button needs: no click follows one. A press given up on while the
   * pointer is still over this 84px target does produce a click, and answering
   * it would take a photo and persist a transcript message from a gesture this
   * component has already decided against.
   *
   * A ref read in `handleClick` for the same reason `heldRef` is one: the click
   * arrives in the same task as the release that ends the press.
   */
  const abandonedRef = useRef(false);

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const cancelHold = useCallback(() => {
    clearHoldTimer();
    holdOriginRef.current = null;
  }, [clearHoldTimer]);

  /**
   * Give up on the press underway, and on the click it may still produce.
   *
   * Only while one is armed, which is the whole scope of this: with no `onHold`
   * on offer nothing arms, so a shutter that only takes photos never suppresses
   * a press. A threshold that has already fired is not armed either, and its
   * release is `heldRef`'s to answer.
   */
  const abandonPress = useCallback(() => {
    if (holdTimerRef.current === null) {
      return;
    }
    // Only a pointer press has a click left to suppress. A Space press had its
    // activation suspended on the way down and re-dispatches one only for a
    // release inside the threshold, which the timer going takes away, so
    // raising the flag there would leave it waiting for a click that never
    // comes to eat some later one instead.
    abandonedRef.current = holdOriginRef.current !== null;
    cancelHold();
  }, [cancelHold]);

  /**
   * A new press begins, so whatever the last one was is over.
   *
   * The flags are normally consumed by the click the press they describe ends
   * with, but the keyboard path produces no click to consume one (the
   * activation was suspended on the way down), a press abandoned off the button
   * produces none either, and a caller that withdraws `onHold` once the hold
   * has done its work leaves nothing else to clear them. Cleared here instead
   * of on release, so a stray click still finds them raised while a later press
   * never does.
   */
  const beginPress = () => {
    heldRef.current = false;
    abandonedRef.current = false;
  };

  const armHold = () => {
    clearHoldTimer();
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      holdOriginRef.current = null;
      heldRef.current = true;
      void haptic.light();
      onHold?.();
    }, LONG_PRESS_THRESHOLD_MS);
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

  /**
   * The press ends when the surface taking it goes away, since the release
   * never arrives.
   *
   * A window losing focus and a page being put away both leave the key or the
   * finger down as far as this element can tell: no `keyup`, no `pointerup`, so
   * an armed threshold fires into a viewfinder nobody is watching. That is the
   * consent model inverted, because entering Live is what a hold does and the
   * room lowers Live on the same edge. So the press dies here entirely: nothing
   * fires, and a release landing after the return is spent rather than read as
   * the tap it was never allowed to become.
   *
   * The bus's `app.hidden` rather than a `visibilitychange` listener, as the
   * room's sight hook does it: the edge is published once from the two sources
   * that report it, and the iOS shell only reports through one of them (see
   * docs/EVENT_BUS.md). Focus is not a bus signal and has no second source, so
   * blur is taken from the window directly.
   */
  useBusSubscription("app.hidden", () => {
    abandonPress();
  });

  useEffect(() => {
    window.addEventListener("blur", abandonPress);
    return () => {
      window.removeEventListener("blur", abandonPress);
    };
  }, [abandonPress]);

  /**
   * The press was made for a hold the caller no longer offers, or on a button
   * that has stopped taking presses.
   *
   * Both arrive mid-press: the room withdraws the hold the moment Live stops
   * being available to enter, and holds the shutter off while a flip swaps the
   * capture underneath it. The armed timer carries the callback from the render
   * that armed it, so left running it fires a hold at a surface that has
   * already decided there is none to give, and the release behind it falls back
   * to a photo pressed for something else.
   */
  useEffect(() => {
    if (holdOffered && !disabled) {
      return;
    }
    abandonPress();
  }, [abandonPress, disabled, holdOffered]);

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // A press that is already over, arriving as its click. Either the hold
    // fired and acted on this press, or the press was abandoned partway
    // through. Nothing here may run for either: not the caller's tap, and not
    // the pulse, which would announce a photo nobody took.
    if (heldRef.current || abandonedRef.current) {
      heldRef.current = false;
      abandonedRef.current = false;
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
    if (!holdOffered || disabled) {
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
    // two. The whole press goes, not just the threshold: the target is 84px
    // across, so a finger can wander past the tolerance and still be over the
    // button when it lifts.
    if (
      Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >
      LONG_PRESS_MOVE_TOLERANCE_PX
    ) {
      abandonPress();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event);
    if (event.repeat) {
      return;
    }
    beginPress();
    if (!holdOffered || disabled) {
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
    if (!holdOffered || event.key !== " ") {
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
      aria-keyshortcuts={holdOffered ? "Space" : undefined}
      aria-describedby={describedBy}
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
        // The whole press, not just the threshold: a pointer that leaves can
        // come back and lift over the button, and a click fires for a down and
        // an up that both landed on it however far it went in between.
        abandonPress();
      }}
      onBlur={(event) => {
        onBlur?.(event);
        // Focus leaving is the press ending, and for a Space press it is the
        // only sign there is: the `keyup` that would end it goes to whatever
        // holds focus now, so the threshold would fire at a button the user
        // has already tabbed off. The window keeps its focus through that, so
        // neither the blur it fires nor the bus edge says anything about it.
        //
        // A pointer press keeps focus by itself, so this reaches one only when
        // something takes it (a dialog opening, a programmatic move), which is
        // a press aimed at a control that no longer has it: the same reading,
        // and the same suppression of the click it may still end with.
        abandonPress();
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

      {/* Inside the button, which is where a single-element component can put
          it: `aria-label` names the button, so its own contents are never read
          as the name, and this is reached by reference rather than by being
          in it. */}
      {description ? (
        <span id={descriptionId} className="sr-only">
          {description}
        </span>
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

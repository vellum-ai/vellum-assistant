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
   * Which pointer the press underway belongs to, so an end of press can be
   * told from any other finger's. A keyboard press owns none, and a press that
   * has ended owns none either: this is a finger currently down, which is also
   * what makes it half the answer to whether the shutter is busy.
   */
  const pressPointerIdRef = useRef<number | null>(null);
  /**
   * The end-of-press event this button handled itself.
   *
   * A release over the button and one that lands elsewhere are the same event
   * name from the document's side, and only the second leaves the flags with
   * no click to be spent on. The button's own handler runs first, since React
   * listens at its root inside the document, so recording what it saw tells
   * the two apart without a containment test and without a ref of this
   * component's own, which a wrapping `Tooltip` already owns.
   */
  const handledEndRef = useRef<Event | null>(null);
  /**
   * A Space press whose native activation this button has taken the default
   * of, and which has not ended yet.
   *
   * The suspension is per keydown, not per press: a key held past the auto
   * repeat delay sends more of them, and one allowed through re-arms the
   * activation the first was taken to withhold. So every repeat of this press
   * has to be taken too, whatever the caller is offering by the time it
   * arrives, since a hold that enters Live withdraws the offer while the key
   * is still down.
   */
  const spacePressRef = useRef(false);

  /**
   * Whether a press has the shutter right now: a threshold still counting, a
   * Space whose activation is suspended, or a finger still down.
   *
   * A press owns this button's state for as long as it lasts, and what it owns
   * has to survive to its own release: the suppression that keeps its ending
   * from turning into a photo, and the suspension that keeps its repeats from
   * re-arming an activation. Both are one press deep, which is what makes the
   * question worth asking before a second one is let in.
   */
  const pressUnderway = () =>
    holdTimerRef.current !== null ||
    spacePressRef.current ||
    pressPointerIdRef.current !== null;

  /**
   * Whether this pointer is the one whose press has the shutter.
   *
   * Every per-press pointer handler asks first, so a second finger cannot
   * abandon the first one's press by wandering, cancel it by leaving, or hand
   * its ownership back by lifting. A press with nothing armed owns nothing and
   * answers false to every pointer, which is what leaves the plain photo
   * shutter to the browser's own handling of a second touch.
   */
  const ownsPress = (pointerId: number) =>
    pressPointerIdRef.current !== null &&
    pointerId === pressPointerIdRef.current;

  /**
   * Nothing of the last press is left to answer for.
   *
   * Both flags exist for the click a release produces, so an end of press that
   * produces none has to spend them itself: left raised they wait for a click
   * that never comes and eat some later activation instead.
   */
  const settlePress = useCallback(() => {
    heldRef.current = false;
    abandonedRef.current = false;
    pressPointerIdRef.current = null;
    spacePressRef.current = false;
  }, []);

  /**
   * A new press begins, so whatever the last one was is over.
   *
   * The backstop rather than the usual route. A press normally settles its own
   * flags: a pointer release spends them on the click it produces, a cancelled
   * pointer spends them itself, and a Space release clears the hold's on its
   * way out. What is left is the press whose end reaches nothing here at all, a
   * finger lifted somewhere off the button or a key released at whatever took
   * focus, and a flag from one of those would sit raised waiting for a click to
   * eat.
   *
   * Cleared at the start of the next press rather than at the end of the last,
   * so a stray click belonging to the press that just ended still finds them
   * raised, while a press that comes after never does.
   */
  const beginPress = () => {
    settlePress();
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
    // A disabled button receives no click, and enabling it again replays none,
    // so a press caught by this has nothing left to spend its flags on. The
    // withdrawal on its own is not the same: that button still takes the
    // release, and the click it fires is what the suppression is for.
    if (disabled) {
      settlePress();
    }
  }, [abandonPress, disabled, holdOffered, settlePress]);

  /**
   * The press ended somewhere this button is not.
   *
   * Nothing is ever captured, so a finger lifted off the button and a key
   * released at whatever took focus are both ends this element never sees, and
   * neither produces a click for it. Left raised through one of those, a flag
   * waits for a click that is not coming and is spent on the next activation
   * instead, which for a screen reader or voice control is a bare click with
   * no press in front of it to clear it first.
   *
   * Narrow on purpose. Nothing raised is one ref read and out, which is what
   * this costs for every release in the app. A pointer end counts only for the
   * pointer that began the press, so a second finger lifting elsewhere does
   * not spend a wandering press's suppression before its own release can. A
   * key end counts only for Space, the one key that arms anything here.
   */
  useEffect(() => {
    const settleIfElsewhere = (event: Event) => {
      if (event === handledEndRef.current) {
        return;
      }
      if (event instanceof KeyboardEvent) {
        if (event.key !== " ") {
          return;
        }
        // The Space press ended at whatever took focus. No repeat of it can
        // reach this button either, so its suspension ends with it.
        spacePressRef.current = false;
        // The DOM's, qualified because this module's `PointerEvent` is the
        // React synthetic one it takes in its own handlers.
      } else if (!ownsPress((event as globalThis.PointerEvent).pointerId)) {
        return;
      } else {
        // The owning pointer is up wherever it landed, so the press it made
        // gives the shutter back. Here rather than with the flags below, so a
        // press that raised none still hands its ownership over.
        pressPointerIdRef.current = null;
      }
      if (!heldRef.current && !abandonedRef.current) {
        return;
      }
      settlePress();
    };
    document.addEventListener("pointerup", settleIfElsewhere);
    document.addEventListener("keyup", settleIfElsewhere);
    return () => {
      document.removeEventListener("pointerup", settleIfElsewhere);
      document.removeEventListener("keyup", settleIfElsewhere);
    };
  }, [settlePress]);

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
    // One gesture at a time, the rule Enter answers to as well. A press has the
    // shutter, so a second finger landing on it begins nothing: beginning one
    // here would settle the bookkeeping of a press whose finger is still down,
    // and the release of a hold that entered Live would then stop it.
    //
    // The owning pointer coming down again is the exception. Its release
    // cannot have reached this button, so that press is over whatever became
    // of it, and this is a new one rather than a shutter stuck owned.
    if (pressUnderway() && event.pointerId !== pressPointerIdRef.current) {
      return;
    }
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
    pressPointerIdRef.current = event.pointerId;
    armHold();
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    onPointerMove?.(event);
    if (!ownsPress(event.pointerId)) {
      return;
    }
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
      // Held past the auto repeat delay. The press is already underway, so
      // there is nothing to begin, but its suspension has to be renewed: an
      // unprevented repeat re-arms the activation the first keydown withheld,
      // and the release then fires a click for a press that was a hold. Only
      // for a press this button actually suspended, so a shutter with no hold
      // on offer keeps the native Space activation its photos are taken by.
      if (event.key === " " && spacePressRef.current) {
        event.preventDefault();
      }
      return;
    }
    // Only the two keys that activate a button are part of a press. A
    // modifier, a letter, a shortcut struck while one is underway belongs to
    // whatever else the user is doing, and settling the press here for it
    // would leave the threshold armed with nothing recording the press it
    // came from: the repeats after it go unsuspended, and the release fires
    // the activation the hold was taken to withhold.
    if (event.key !== " " && event.key !== "Enter") {
      return;
    }
    // One gesture at a time, and the one that started owns the shutter. Enter
    // arriving over a press does nothing at all: its own activation is taken,
    // and the press underway keeps everything it is holding, which is what
    // carries its suppression and its suspension through to its own release.
    // Taking the default is what stops the browser activating the button from
    // this key, since for a button that activation IS the keydown's default.
    if (event.key === "Enter" && pressUnderway()) {
      event.preventDefault();
      return;
    }
    // A Space landing on a press still recorded is a press whose end never
    // reached this button, so a new one begins and the old one's threshold
    // goes with it rather than firing into the new press's ending.
    abandonPress();
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
    spacePressRef.current = true;
    armHold();
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    onKeyUp?.(event);
    if (event.key !== " ") {
      return;
    }
    // This release is the button's own, so the document listener leaves it to
    // the handling below rather than reading it as an end that landed
    // elsewhere.
    handledEndRef.current = event.nativeEvent;
    // The press is over, so no repeat of it can arrive to be suspended.
    spacePressRef.current = false;
    // The press this key began is over, whatever is on offer by the time it
    // ends. A fired hold raises a suppression for a click only a pointer
    // release produces, so left up it waits for one that never comes and is
    // spent on some later activation instead. Assistive technology and voice
    // control dispatch a bare click with no press in front of it, so that
    // activation has nothing of its own to clear the flag first, and the
    // user's press does nothing.
    heldRef.current = false;
    // The tap the release turns out to be is still the caller's to be offered
    // a hold for: with none on offer the browser's own activation was never
    // suspended, so there is nothing here to re-dispatch.
    if (!holdOffered) {
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
        if (!ownsPress(event.pointerId)) {
          return;
        }
        // Recorded, not settled. Nothing is ever captured, so a release
        // reaching this handler is one that happened over the button, and a
        // down and an up that both landed on it fire the click the suppression
        // exists for. Spending it anywhere but on that click is what would
        // hand a wandering press its photo back, so the document listener is
        // told to leave this one alone.
        handledEndRef.current = event.nativeEvent;
        // The finger is up, so no press has the shutter any more. The flags it
        // may have raised are untouched: the click on its way is what spends
        // them.
        pressPointerIdRef.current = null;
        cancelHold();
      }}
      onPointerCancel={(event) => {
        onPointerCancel?.(event);
        if (!ownsPress(event.pointerId)) {
          return;
        }
        cancelHold();
        // The one end of a press this element hears that is certain to produce
        // no click: a pointer the browser has taken back fires none. Both
        // flags, because both are raised by a pointer press and neither has
        // anything left to be spent on, whether the press was given up on
        // partway or ran all the way to a hold. Left up they are spent on some
        // later activation instead, which for a screen reader or voice control
        // is a bare click with no press in front of it to clear them first.
        // `cancelHold` above leaves nothing armed, so the press is wholly over
        // here.
        settlePress();
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event);
        if (!ownsPress(event.pointerId)) {
          return;
        }
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
        // A Space press needs this button focused, so focus leaving takes its
        // release with it, and a window losing focus or a tab going away reach
        // it here too. The suspension ends now rather than at a keyup that
        // never arrives: left raised it goes on answering that a press has the
        // shutter, and every later press, finger or key, is turned away by a
        // gesture long over.
        spacePressRef.current = false;
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

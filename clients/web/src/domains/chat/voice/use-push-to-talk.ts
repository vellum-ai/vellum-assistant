import { useEffect, useRef, type RefObject } from "react";

import {
  eventActivatesPTT,
  eventDeactivatesPTT,
  pushToTalkActivation,
  type PTTActivator,
} from "@/utils/ptt-activator";
import {
  isConfigurablePushToTalkActive,
  subscribeToHotkeyEvents,
  subscribeToConfigurablePushToTalk,
  supportsConfigurablePushToTalk,
  type HotkeyEvent,
} from "@/runtime/hotkey";
import { getAudioContextCtor } from "@/domains/chat/voice/audio-context";
import { setPushToTalkHoldActive } from "@/domains/chat/voice/push-to-talk-hold";
import { playBlip } from "@/lib/sounds/blip";

/**
 * Imperative handle (subset of `VoiceInputButtonHandle`) that the hook drives.
 * Kept local to avoid a cycle with the button component.
 */
export interface PushToTalkTarget {
  start: () => void;
  stop: () => void;
}

type PushToTalkTargetSource =
  | RefObject<PushToTalkTarget | null>
  | (() => PushToTalkTarget | null);

function resolvePushToTalkTarget(
  source: PushToTalkTargetSource,
): PushToTalkTarget | null {
  return typeof source === "function" ? source() : source.current;
}

/**
 * Elements where key-based activators should not trigger PTT. Modifier-only
 * activators are still allowed so PTT works while the chat composer is focused;
 * shortcut chords cancel during the hold window below.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Minimum hold duration before a single-input PTT binding activates. */
const PTT_HOLD_DELAY_MS = 100;

/** Audible feedback when recording starts; a throwaway context per blip. */
function playActivationBlip(): void {
  try {
    const AudioContextCtor = getAudioContextCtor();
    if (!AudioContextCtor) {
      return;
    }
    const ctx = new AudioContextCtor();
    playBlip(ctx).onended = () => {
      void ctx.close();
    };
  } catch {
    // Autoplay can be blocked until the user interacts with the page.
  }
}

/**
 * Hold-to-talk on `window` keydown/keyup, driving the voice-input handle.
 * Modifier-only bindings wait out the hold delay so taps and shortcuts that
 * share the prefix (Ctrl+C, Ctrl+Shift+T) cancel instead of recording; key
 * chords (Ctrl+K) activate on their key. Focused-window only, unless a
 * desktop host owns the binding globally, in which case the native events
 * drive the same handle.
 */
export function usePushToTalk(
  targetSource: PushToTalkTargetSource,
  options: { enabled?: boolean } = {},
): void {
  const { enabled = true } = options;
  const activatorRef = useRef<PTTActivator>({ kind: "off" });
  const activeRef = useRef(false);
  const activeOriginRef = useRef<"dom" | "native" | null>(null);
  const activeTargetRef = useRef<PushToTalkTarget | null>(null);

  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdingRef = useRef(false);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    const nativeConfigurable = supportsConfigurablePushToTalk();
    const readActivator = () => {
      activatorRef.current = pushToTalkActivation.load();
    };
    readActivator();

    const cancelHold = () => {
      if (holdTimerRef.current !== null) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      holdingRef.current = false;
    };

    const startActiveTarget = (origin: "dom" | "native") => {
      const target = resolvePushToTalkTarget(targetSource);
      if (!target) {
        return;
      }
      activeRef.current = true;
      activeOriginRef.current = origin;
      activeTargetRef.current = target;
      setPushToTalkHoldActive(true);
      playActivationBlip();
      target.start();
    };

    const stopActiveTarget = () => {
      const target =
        activeTargetRef.current ?? resolvePushToTalkTarget(targetSource);
      activeRef.current = false;
      activeOriginRef.current = null;
      activeTargetRef.current = null;
      setPushToTalkHoldActive(false);
      target?.stop();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (nativeConfigurable && isConfigurablePushToTalkActive()) {
        return;
      }
      if (event.repeat) {
        return;
      }
      const activator = activatorRef.current;
      if (activator.kind === "off") {
        return;
      }

      // Cancel hold before the editable-target check so that keystrokes
      // targeting an input during the hold window still cancel activation.
      if (holdingRef.current && !eventActivatesPTT(event, activator)) {
        cancelHold();
        return;
      }

      if (activator.kind === "key" && isEditableTarget(event.target)) {
        return;
      }
      // A key chord another listener already claimed (the Talk shortcut in a
      // browser, a composer binding) is theirs; starting dictation too would
      // fire both. Modifier-only bindings keep the tap-vs-hold split instead.
      if (activator.kind === "key" && event.defaultPrevented) {
        return;
      }

      if (!eventActivatesPTT(event, activator)) {
        return;
      }
      if (activeRef.current || holdingRef.current) {
        return;
      }

      // A key chord ends with its key, so it is unambiguous on arrival. A
      // modifier-only chord may be the prefix of a shortcut, so it waits.
      if (activator.kind === "key" && activator.modifiers.length > 0) {
        startActiveTarget("dom");
        return;
      }
      holdingRef.current = true;
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        if (!holdingRef.current) {
          return;
        }
        // Re-check activator in case it changed during the hold window.
        if (activatorRef.current.kind === "off") {
          holdingRef.current = false;
          return;
        }
        holdingRef.current = false;
        startActiveTarget("dom");
      }, PTT_HOLD_DELAY_MS);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (nativeConfigurable && isConfigurablePushToTalkActive()) {
        return;
      }
      const activator = activatorRef.current;
      if (activator.kind === "off") {
        return;
      }

      // Cancel a pending key chord when its key or final required modifier is
      // released before the timer fires.
      if (
        holdingRef.current &&
        activator.kind === "key" &&
        eventDeactivatesPTT(event, activator)
      ) {
        cancelHold();
        return;
      }

      if (!eventDeactivatesPTT(event, activator)) {
        return;
      }

      if (holdingRef.current) {
        cancelHold();
        return;
      }

      if (!activeRef.current) {
        return;
      }
      stopActiveTarget();
    };

    const handleNativeHotkey = (event: HotkeyEvent) => {
      if (!nativeConfigurable || !isConfigurablePushToTalkActive()) {
        return;
      }
      if (event.state === "down") {
        cancelHold();
        if (activeRef.current) {
          return;
        }
        startActiveTarget("native");
        return;
      }

      if (!activeRef.current || activeOriginRef.current !== "native") {
        return;
      }
      stopActiveTarget();
    };

    const handleBlur = () => {
      // Cancel when focus drops during the hold window.
      cancelHold();

      // DOM keyup can be lost when the page blurs. Native events are delivered
      // while the app is in the background, so leave those sessions running
      // until the helper sends the up event.
      if (activeRef.current && activeOriginRef.current !== "native") {
        stopActiveTarget();
      }
    };

    const unsubscribeSetting = pushToTalkActivation.subscribe(() => {
      cancelHold();
      if (activeRef.current) {
        stopActiveTarget();
      }
      readActivator();
    });
    const unsubscribeNative = subscribeToHotkeyEvents(handleNativeHotkey);
    // Native capture taking over ends a DOM hold; native capture dropping
    // (helper restart, binding revoked) ends a native hold, since its up
    // event may never arrive.
    const unsubscribeRegistration = subscribeToConfigurablePushToTalk(
      (active) => {
        cancelHold();
        const orphaned = active ? "dom" : "native";
        if (activeRef.current && activeOriginRef.current === orphaned) {
          stopActiveTarget();
        }
      },
    );

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
      unsubscribeSetting();
      unsubscribeNative();
      unsubscribeRegistration();
      cancelHold();
      if (activeRef.current) {
        stopActiveTarget();
      }
    };
  }, [enabled, targetSource]);
}

// Re-export for testing.
export { PTT_HOLD_DELAY_MS, playActivationBlip };

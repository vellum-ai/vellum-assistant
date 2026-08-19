import { useEffect, useRef, type RefObject } from "react";

import {
  LS_PTT_ACTIVATION_KEY,
  eventActivatesPTT,
  eventDeactivatesPTT,
  parseActivator,
  type PTTActivator,
} from "@/utils/ptt-activator";
import { getLocalSetting, watchSetting } from "@/utils/local-settings";
import {
  isConfigurablePushToTalkActive,
  subscribeToHotkeyEvents,
  subscribeToConfigurablePushToTalk,
  supportsConfigurablePushToTalk,
  type HotkeyEvent,
} from "@/runtime/hotkey";

/**
 * Imperative handle (subset of `VoiceInputButtonHandle`) that the hook drives.
 * Kept local to avoid a cycle with the button component.
 */
export interface PushToTalkTarget {
  start: () => void;
  stop: () => void;
}

type PushToTalkTargetSource =
  RefObject<PushToTalkTarget | null> | (() => PushToTalkTarget | null);

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

/**
 * Play a short activation blip via the Web Audio API to provide audible
 * feedback when PTT recording starts. Standalone helper to avoid coupling
 * with `SoundManager`.
 *
 * 880 Hz sine tone, 200 ms duration, 0.25 peak gain — same parameters as
 * `SoundManager.playFallbackBlip`.
 */
function playActivationBlip(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const AudioContextCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextCtor) {
      return;
    }

    const ctx = new AudioContextCtor();
    if (ctx.state === "suspended") {
      void ctx.resume();
    }

    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, ctx.currentTime);

    const peak = 0.25;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(peak, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.2);

    // Close the context after playback to avoid leaking resources.
    oscillator.onended = () => {
      void ctx.close();
    };
  } catch {
    // Autoplay can be blocked until the user interacts with the page; a
    // failed blip is non-fatal.
  }
}

/**
 * Listens for the saved PTT activator on `window` keydown/keyup and drives
 * the provided voice-input handle. Hold-to-talk: key-down starts recording
 * after a 100 ms hold delay, key-up stops it. Multi-input chords activate as
 * soon as their final key arrives. Only fires while the Vellum tab has focus
 * unless a configurable desktop host owns the binding globally.
 *
 * The 100 ms hold delay prevents accidental activation from quick taps. If
 * another non-modifier key is pressed during the hold window, activation is
 * cancelled (the user is likely typing a shortcut like Ctrl+C).
 *
 * Storage lives in `localStorage` under `LS_PTT_ACTIVATION_KEY`; the hook
 * re-reads on `storage` events so PTT picks up changes made in the settings
 * UI without a reload.
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

  // Hold-delay state — tracked via refs so event handlers always see the
  // latest values without requiring effect re-runs.
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdingRef = useRef(false);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    const nativeConfigurable = supportsConfigurablePushToTalk();
    const readActivator = () => {
      const raw = getLocalSetting(LS_PTT_ACTIVATION_KEY, "");
      activatorRef.current = raw ? parseActivator(raw) : { kind: "off" };
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
      playActivationBlip();
      target.start();
    };

    const stopActiveTarget = () => {
      const target =
        activeTargetRef.current ?? resolvePushToTalkTarget(targetSource);
      activeRef.current = false;
      activeOriginRef.current = null;
      activeTargetRef.current = null;
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

      if (!eventActivatesPTT(event, activator)) {
        return;
      }
      if (activeRef.current || holdingRef.current) {
        return;
      }

      holdingRef.current = true;
      const inputCount =
        activator.modifiers.length + (activator.kind === "key" ? 1 : 0);
      if (inputCount > 1) {
        holdingRef.current = false;
        startActiveTarget("dom");
        return;
      }
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

      // For key activators with required modifiers (e.g. Ctrl+K), cancel
      // the hold if a required modifier is released before the timer fires.
      // eventDeactivatesPTT only matches the trigger key, not modifiers.
      if (
        holdingRef.current &&
        activator.kind === "key" &&
        activator.modifiers.length > 0
      ) {
        const k = event.key;
        const mods = activator.modifiers;
        if (
          (k === "Control" && mods.includes("control")) ||
          (k === "Alt" && mods.includes("option")) ||
          (k === "Shift" && mods.includes("shift")) ||
          (k === "Meta" && mods.includes("command"))
        ) {
          cancelHold();
          return;
        }
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
      if (nativeConfigurable && !isConfigurablePushToTalkActive()) {
        return;
      }
      if (!nativeConfigurable) {
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
      // Dropping focus while in the hold window — cancel.
      cancelHold();

      // DOM keyup can be lost when the page blurs. Native events are delivered
      // while the app is in the background, so leave those sessions running
      // until the helper sends the up event.
      if (activeRef.current && activeOriginRef.current !== "native") {
        stopActiveTarget();
      }
    };

    const unsubscribeSetting = watchSetting(LS_PTT_ACTIVATION_KEY, () => {
      cancelHold();
      if (activeRef.current) {
        stopActiveTarget();
      }
      readActivator();
    });
    const unsubscribeNative = subscribeToHotkeyEvents(handleNativeHotkey);
    const unsubscribeRegistration = subscribeToConfigurablePushToTalk(
      (active) => {
        if (!active) {
          return;
        }
        cancelHold();
        if (activeRef.current && activeOriginRef.current === "dom") {
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

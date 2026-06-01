
import { useEffect, useRef, type RefObject } from "react";

import {
  LS_PTT_ACTIVATION_KEY,
  eventActivatesPTT,
  eventDeactivatesPTT,
  parseActivator,
  type PTTActivator,
} from "@/utils/ptt-activator";
import { getLocalSetting } from "@/utils/local-settings";

/**
 * Imperative handle (subset of `VoiceInputButtonHandle`) that the hook drives.
 * Kept local to avoid a cycle with the button component.
 */
interface PushToTalkTarget {
  start: () => void;
  stop: () => void;
}

/**
 * Elements whose keyboard events should never trigger PTT. Modifier-only
 * activators like plain "Ctrl" are common editing modifiers (Ctrl+C,
 * Ctrl+A, Ctrl+Enter) and holding Ctrl alone while typing should not start
 * voice capture. We skip all editable targets unconditionally.
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

/** Minimum hold duration (ms) before PTT activates, matching macOS PTTActivator. */
const PTT_HOLD_DELAY_MS = 300;

/**
 * Play a short activation blip via the Web Audio API to provide audible
 * feedback when PTT recording starts. Standalone helper to avoid coupling
 * with `SoundManager`.
 *
 * 880 Hz sine tone, 200 ms duration, 0.25 peak gain — same parameters as
 * `SoundManager.playFallbackBlip`.
 */
function playActivationBlip(): void {
  if (typeof window === "undefined") return;
  try {
    const AudioContextCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextCtor) return;

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
 * after a 300 ms hold delay, key-up stops it. Only fires while the Vellum
 * tab has focus — browsers cannot observe global/OS-level hotkeys.
 *
 * The 300 ms hold delay prevents accidental activation from quick taps and
 * system shortcuts (matching the macOS `PTTActivator` behaviour). If
 * another non-modifier key is pressed during the hold window, activation
 * is cancelled (the user is likely typing a shortcut like Ctrl+C).
 *
 * Storage lives in `localStorage` under `LS_PTT_ACTIVATION_KEY`; the hook
 * re-reads on `storage` events so PTT picks up changes made in the settings
 * UI without a reload.
 */
export function usePushToTalk(
  targetRef: RefObject<PushToTalkTarget | null>,
  options: { enabled?: boolean } = {},
): void {
  const { enabled = true } = options;
  const activatorRef = useRef<PTTActivator>({ kind: "off" });
  const activeRef = useRef(false);

  // Hold-delay state — tracked via refs so event handlers always see the
  // latest values without requiring effect re-runs.
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdingRef = useRef(false);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

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

    const handleKeyDown = (event: KeyboardEvent) => {
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

      if (isEditableTarget(event.target)) {
        return;
      }

      if (!eventActivatesPTT(event, activator)) {
        return;
      }
      if (activeRef.current || holdingRef.current) {
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
        activeRef.current = true;
        playActivationBlip();
        targetRef.current?.start();
      }, PTT_HOLD_DELAY_MS);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const activator = activatorRef.current;
      if (activator.kind === "off") {
        return;
      }

      // For key activators with required modifiers (e.g. Ctrl+K), cancel
      // the hold if a required modifier is released before the timer fires.
      // eventDeactivatesPTT only matches the trigger key, not modifiers.
      if (holdingRef.current && activator.kind === "key" && activator.modifiers.length > 0) {
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
      activeRef.current = false;
      targetRef.current?.stop();
    };

    const handleBlur = () => {
      // Dropping focus while in the hold window — cancel.
      cancelHold();

      // Dropping focus while the key is held means we'll never see the keyup.
      // Stop the session so the recognizer doesn't run forever.
      if (activeRef.current) {
        activeRef.current = false;
        targetRef.current?.stop();
      }
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key === LS_PTT_ACTIVATION_KEY) {
        readActivator();
      }
    };

    const target = targetRef;

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("storage", handleStorage);
      cancelHold();
      if (activeRef.current) {
        activeRef.current = false;
        target.current?.stop();
      }
    };
  }, [enabled, targetRef]);
}

// Re-export for testing.
export { PTT_HOLD_DELAY_MS, playActivationBlip };

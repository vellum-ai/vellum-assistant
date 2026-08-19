import { useEffect, useRef, type RefObject } from "react";

import {
  FN_PTT_ACTIVATOR,
  LS_PTT_ACTIVATION_KEY,
  eventActivatesPTT,
  eventDeactivatesPTT,
  isFnPushToTalkActivator,
  parseActivator,
  type PTTActivator,
  type PTTModifier,
} from "@/utils/ptt-activator";
import { getLocalSetting, watchSetting } from "@/utils/local-settings";
import {
  subscribeToHotkeyEvents,
  supportsFnPushToTalk,
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

/** Hold guard for a single key or modifier. */
const PTT_HOLD_DELAY_MS = 100;
const MODIFIER_BY_KEY: Partial<Record<string, PTTModifier>> = {
  Alt: "option",
  Control: "control",
  Meta: "command",
  Shift: "shift",
};

function activatesImmediately(activator: PTTActivator): boolean {
  if (activator.kind === "off") {
    return false;
  }
  const modifierCount = activator.modifiers.filter(
    (modifier) => modifier !== "function",
  ).length;
  const inputCount = modifierCount + (activator.kind === "key" ? 1 : 0);
  return inputCount > 1;
}

function isActivatorInput(
  event: KeyboardEvent,
  activator: PTTActivator,
): boolean {
  if (activator.kind === "off") {
    return false;
  }
  if (eventActivatesPTT(event, activator)) {
    return true;
  }
  if (activator.kind !== "modifierOnly") {
    return false;
  }
  const modifier = MODIFIER_BY_KEY[event.key];
  return modifier !== undefined && activator.modifiers.includes(modifier);
}

function shouldClaimActivatorInput(
  event: KeyboardEvent,
  activator: PTTActivator,
): boolean {
  return !(
    activator.kind === "key" && isEditableTarget(event.target)
  ) && isActivatorInput(event, activator);
}

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
 * after a short hold guard, key-up stops it. Multi-key chords start as soon
 * as the final key is pressed. Only fires while the Vellum
 * tab has focus. Electron's app-level native Fn bridge bypasses this DOM path
 * so the desktop app can keep PTT active while it is in the background.
 *
 * The hold guard prevents accidental activation from quick taps and system
 * shortcuts. If
 * another non-modifier key is pressed during the hold window, activation
 * is cancelled (the user is likely typing a shortcut like Ctrl+C).
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

    const nativeFnAvailable = supportsFnPushToTalk();
    const readActivator = () => {
      const raw = getLocalSetting(LS_PTT_ACTIVATION_KEY, "");
      activatorRef.current = raw
        ? parseActivator(raw, { preserveFunction: nativeFnAvailable })
        : nativeFnAvailable
          ? FN_PTT_ACTIVATOR
          : { kind: "off" };
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
      const activator = activatorRef.current;
      if (activator.kind === "off") {
        return;
      }
      if (shouldClaimActivatorInput(event, activator)) {
        event.preventDefault();
      }
      if (event.repeat) {
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
      const activate = () => {
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
      };
      if (activatesImmediately(activator)) {
        activate();
        return;
      }
      holdTimerRef.current = setTimeout(activate, PTT_HOLD_DELAY_MS);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const activator = activatorRef.current;
      if (activator.kind === "off") {
        return;
      }
      if (shouldClaimActivatorInput(event, activator)) {
        event.preventDefault();
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
      if (
        !nativeFnAvailable ||
        !isFnPushToTalkActivator(activatorRef.current)
      ) {
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

      // DOM keyup can be lost when the page blurs. Native Fn events are
      // delivered by the host helper while the app is in the background, so
      // leave those sessions running until the helper sends the up event.
      if (activeRef.current && activeOriginRef.current !== "native") {
        stopActiveTarget();
      }
    };

    const unsubscribeSetting = watchSetting(
      LS_PTT_ACTIVATION_KEY,
      readActivator,
    );
    const unsubscribeNative = subscribeToHotkeyEvents(handleNativeHotkey);

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleBlur);
      unsubscribeSetting();
      unsubscribeNative();
      cancelHold();
      if (activeRef.current) {
        stopActiveTarget();
      }
    };
  }, [enabled, targetSource]);
}

// Re-export for testing.
export { PTT_HOLD_DELAY_MS, playActivationBlip };

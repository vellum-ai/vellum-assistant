import { useEffect, useState } from "react";

import type { KeyboardModifier } from "@vellumai/ipc-contract";

import {
  getLocalSetting,
  setLocalSetting,
  watchSetting,
} from "@/utils/local-settings";
import { parseActivator } from "@/utils/ptt-activator";

/**
 * The key every voice gesture rides on: hold it to dictate, double-tap it for
 * a call.
 *
 * One binding rather than one per gesture. The gestures are how the key is
 * pressed, and a user who moves the key moves all of them; a card offering a
 * key per gesture would be asking the same question twice.
 *
 * Shared rather than owned by either side. Settings offers the choice and chat
 * runs the binding, and a domain reaching across for it is the thing the
 * boundary exists to stop.
 */
export type VoiceKey =
  | { kind: "off" }
  | { kind: "modifierOnly"; modifiers: KeyboardModifier[] };

export const LS_VOICE_KEY = "vellum:voice:voiceKey";

/**
 * Fn, out of the box.
 *
 * The key is the user's before it is ours, and macOS runs its own answer to a
 * tap of it, so a single tap is left alone: the gestures taken are the ones
 * nothing else on the machine claims. The one collision is macOS Dictation's
 * optional "press Fn twice", which the settings card notes.
 */
export const FN_VOICE_KEY: VoiceKey = {
  kind: "modifierOnly",
  modifiers: ["function"],
};

/** The set the hold shipped on before it had a key of its own. */
const LEGACY_HOLD_MODIFIERS: KeyboardModifier[] = ["control", "option"];

/**
 * The two settings this one replaces, read when it is not yet stored so an
 * upgrade keeps what the user had: a hold on Ctrl+Option stays on Ctrl+Option,
 * a chosen Fn tap lands on Fn, and anything the user switched off (the hold,
 * or the shortcut) stays off rather than becoming a key they never asked for.
 */
const LS_LEGACY_HOLD_TO_DICTATE = "vellum:voice:holdToDictate";
const LS_LEGACY_VOICE_MODE_ACTIVATION = "vellum:voice:voiceModeActivation";

const MODIFIER_NAMES: ReadonlySet<string> = new Set<KeyboardModifier>([
  "function",
  "control",
  "shift",
  "option",
  "command",
]);

function isKeyboardModifier(value: unknown): value is KeyboardModifier {
  return typeof value === "string" && MODIFIER_NAMES.has(value);
}

function parseVoiceKey(raw: string): VoiceKey | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const candidate = parsed as { kind?: unknown; modifiers?: unknown };
    if (candidate.kind === "off") {
      return { kind: "off" };
    }
    if (
      candidate.kind === "modifierOnly" &&
      Array.isArray(candidate.modifiers)
    ) {
      const modifiers = candidate.modifiers.filter(isKeyboardModifier);
      return modifiers.length > 0
        ? { kind: "modifierOnly", modifiers: Array.from(new Set(modifiers)) }
        : null;
    }
  } catch {
    // A hand edit, or nothing this app wrote.
  }
  return null;
}

function legacyVoiceKey(): VoiceKey {
  const hold = getLocalSetting(LS_LEGACY_HOLD_TO_DICTATE, "");
  if (hold === "true") {
    return { kind: "modifierOnly", modifiers: LEGACY_HOLD_MODIFIERS };
  }
  const activation = getLocalSetting(LS_LEGACY_VOICE_MODE_ACTIVATION, "");
  const activator = activation ? parseActivator(activation) : null;
  if (activator?.kind === "modifierOnly") {
    // The one bare modifier that setting accepted on this host was Fn.
    return FN_VOICE_KEY;
  }
  if (hold === "false" || activator?.kind === "off") {
    return { kind: "off" };
  }
  return FN_VOICE_KEY;
}

export function readVoiceKey(): VoiceKey {
  const raw = getLocalSetting(LS_VOICE_KEY, "");
  return (raw && parseVoiceKey(raw)) || legacyVoiceKey();
}

export function writeVoiceKey(key: VoiceKey): void {
  setLocalSetting(LS_VOICE_KEY, JSON.stringify(key));
}

export function isFnVoiceKey(key: VoiceKey): boolean {
  return (
    key.kind === "modifierOnly" &&
    key.modifiers.length === 1 &&
    key.modifiers[0] === "function"
  );
}

/** Subscribe to the setting, including changes made in another window. */
export function useVoiceKey(): VoiceKey {
  const [key, setKey] = useState(readVoiceKey);
  useEffect(
    () =>
      watchSetting(LS_VOICE_KEY, () => {
        setKey(readVoiceKey());
      }),
    [],
  );
  return key;
}

/**
 * Whether the dictation being recorded was started by the held key.
 *
 * A hold is aimed at a cursor in another application and shows its words on
 * the companion while they are said, so what it owes the user is the sentence
 * they just read, as soon as they stop. That is a different bargain from the
 * composer's microphone, which can afford to wait for the best answer because
 * nobody is standing in another app watching for it.
 *
 * A flag rather than a parameter because the recording is started through an
 * imperative handle on whichever `VoiceInputButton` currently owns dictation,
 * which is the composer's on a chat route and a headless one everywhere else.
 * Read once when a session starts, so what it says later cannot change the
 * bargain a session was begun under.
 */
let holdDictation = false;

export function markHoldDictation(active: boolean): void {
  holdDictation = active;
}

export function isHoldDictation(): boolean {
  return holdDictation;
}

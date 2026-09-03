import type {
  ModifierHold,
  ModifierHoldRegistrationResult,
  VoiceModeChord,
} from "@vellumai/ipc-contract";

import { isElectron, type HotkeyEvent } from "@/runtime/is-electron";

export type { HotkeyEvent };

export function supportsFnPushToTalk(): boolean {
  return (
    isElectron() &&
    typeof window.vellum?.helper?.hotkey?.fnPushToTalk === "function" &&
    typeof window.vellum?.helper?.hotkey?.onEvent === "function"
  );
}

export function supportsVoiceModeChord(): boolean {
  return (
    isElectron() &&
    typeof window.vellum?.helper?.hotkey?.setVoiceModeChord === "function" &&
    typeof window.vellum?.helper?.hotkey?.onEvent === "function"
  );
}

export async function setNativeVoiceModeChord(
  activator: VoiceModeChord | null,
): Promise<boolean> {
  if (!supportsVoiceModeChord()) {
    return false;
  }
  try {
    const result =
      await window.vellum!.helper!.hotkey!.setVoiceModeChord!(activator);
    return result.ok;
  } catch {
    return false;
  }
}

export async function setFnPushToTalkEnabled(
  enable: boolean,
): Promise<boolean> {
  if (!supportsFnPushToTalk()) {
    return false;
  }
  try {
    const result = await window.vellum!.helper!.hotkey!.fnPushToTalk!(enable);
    return result.ok;
  } catch {
    return false;
  }
}

/**
 * Whether this host can watch a held modifier set system-wide.
 *
 * The DOM cannot: a held chord only reaches a focused window, and the point of
 * this binding is that the user is in some other app. So the answer is whether
 * the host has a helper that reads the raw keyboard.
 */
export function supportsModifierHold(): boolean {
  return (
    isElectron() &&
    typeof window.vellum?.helper?.hotkey?.setModifierHold === "function"
  );
}

/**
 * Point the host's hold detector at a modifier set, or clear it.
 *
 * Resolves `false` off a host that cannot watch one, so callers can treat an
 * absent binding and a refused one the same way: there is no hold either way.
 */
export async function setModifierHold(
  hold: ModifierHold,
): Promise<ModifierHoldRegistrationResult> {
  const set = window.vellum?.helper?.hotkey?.setModifierHold;
  if (!isElectron() || typeof set !== "function") {
    return { ok: false, reason: "host cannot watch a held modifier set" };
  }
  return set(hold);
}

export function subscribeToHotkeyEvents(
  callback: (event: HotkeyEvent) => void,
): () => void {
  const subscribe = window.vellum?.helper?.hotkey?.onEvent;
  return subscribe ? subscribe(callback) : () => undefined;
}

export function subscribeToVoiceModeChordRegistration(
  callback: (active: boolean) => void,
): () => void {
  const subscribe = window.vellum?.helper?.hotkey?.onRegistrationChange;
  return subscribe ? subscribe(callback) : () => undefined;
}

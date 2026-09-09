import type {
  ChordBinding,
  ChordRegistrationResult,
  HotkeySelection,
  ModifierHold,
  ModifierHoldRegistrationResult,
  VoiceModeChord,
} from "@vellumai/ipc-contract";

import { isElectron, type HotkeyEvent } from "@/runtime/is-electron";

export type { HotkeyEvent };

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

/**
 * What is highlighted in the application in front, or `null` when nothing is.
 *
 * `null` too off a host that cannot read one, since a hold that finds no
 * selection lands its words at the cursor, which is the right answer there.
 */
export async function readFrontSelection(): Promise<HotkeySelection | null> {
  const read = window.vellum?.helper?.hotkey?.readFrontSelection;
  if (!isElectron() || typeof read !== "function") {
    return null;
  }
  try {
    return await read();
  } catch {
    return null;
  }
}

/**
 * Whether this host can watch for a chord anywhere on the desktop.
 *
 * The same answer `supportsModifierHold` gives and for the same reason: the
 * DOM sees a chord only in a focused window, and the press this binding exists
 * for is made in some other application.
 */
export function supportsChords(): boolean {
  return (
    isElectron() &&
    typeof window.vellum?.helper?.hotkey?.setChords === "function"
  );
}

/**
 * Arm a chord binding on the host, or clear it with `off`.
 *
 * Refused off a host that cannot watch one, so a caller reads an absent
 * binding and a rejected one the same way: no chord is coming either way.
 */
export async function setChordBinding(
  binding: ChordBinding,
): Promise<ChordRegistrationResult> {
  const set = window.vellum?.helper?.hotkey?.setChords;
  if (!isElectron() || typeof set !== "function") {
    return { ok: false, reason: "host cannot watch a chord" };
  }
  return set(binding);
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

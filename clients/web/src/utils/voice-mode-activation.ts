import {
  detectElectronHostOS,
  isMacOSBrowser,
} from "@/runtime/platform-detection";
import { isElectron } from "@/runtime/is-electron";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import {
  type PTTActivator,
  eventActivatesPTT,
  parseActivator,
  serializeActivator,
} from "@/utils/ptt-activator";

/**
 * The binding that starts and ends a live voice session on hosts without a
 * voice key (`utils/voice-key`): a keyboard shortcut.
 *
 * Reuses the activator shape push to talk already stores, so the settings
 * recorder, the serialization, and the keyboard matching are shared. Two
 * differences follow from voice mode being a toggle rather than a hold:
 *
 * - Modifier-only bindings are rejected. Holding Ctrl to talk is deliberate;
 *   tapping it is not, so every abandoned Ctrl chord would toggle a session.
 *   The Windows desktop host is the exception (see below).
 * - The binding lives under its own storage key. Reusing the push-to-talk key
 *   would silently turn someone's hold-to-dictate binding into a voice toggle.
 */
export type VoiceModeActivator = PTTActivator;

export const LS_VOICE_MODE_ACTIVATION_KEY = "vellum:voice:voiceModeActivation";

/**
 * The default binding off a Mac desktop host: Cmd+Shift+V on macOS,
 * Ctrl+Shift+V elsewhere.
 *
 * Deliberately a chord with a real modifier and a non-modifier key. It emits
 * no character, so the listener can fire while the composer holds focus,
 * which is where someone is standing when they reach for voice. Its one
 * collision is paste-as-plain-text, and our own text surfaces are plain
 * textareas where that is indistinguishable from an ordinary paste.
 */
export function keyboardDefaultActivator(): VoiceModeActivator {
  return {
    kind: "key",
    label: "V",
    modifiers: [isMacOSBrowser() ? "command" : "control", "shift"],
  };
}

/**
 * The out-of-the-box binding: the chord where it is live, and nothing at all
 * on the desktop app.
 *
 * On the desktop app the chord rail is the global Talk shortcut, which ships
 * unbound for its own reasons (`GLOBAL_SHORTCUT_DEFAULTS`), and the DOM chord
 * below is never bound there (see `use-voice-mode-hotkey`). So nothing is
 * bound until the user says what should be, which is the honest answer rather
 * than a chord this host would not listen for anyway.
 */
export function defaultVoiceModeActivator(): VoiceModeActivator {
  return isElectron() ? { kind: "off" } : keyboardDefaultActivator();
}

/**
 * Whether the host offers bare-modifier voice mode bindings (a tap of Ctrl,
 * Alt, or Ctrl+Shift). Windows desktop only: it has no Fn channel, and an
 * Electron `globalShortcut` cannot express a bare modifier, so these bind as
 * focused-window tap listeners instead (see `use-voice-mode-hotkey`).
 */
export function supportsBareModifierVoiceMode(): boolean {
  return detectElectronHostOS() === "windows";
}

/**
 * Whether `activator` can bind voice mode. Rejects modifier-only bindings
 * (see the note on {@link VoiceModeActivator}), except on the Windows desktop
 * host, where a bare-modifier tap is the global binding.
 */
export function isValidVoiceModeActivator(
  activator: VoiceModeActivator,
): boolean {
  if (activator.kind === "modifierOnly") {
    return supportsBareModifierVoiceMode();
  }
  return true;
}

/**
 * The stored binding, or the host default when nothing usable is stored: a
 * modifier-only leftover from the push-to-talk era, a Fn binding from before
 * Fn was the voice key, or a hand edit, reads as nothing stored rather than as
 * a binding.
 */
export function readVoiceModeActivator(): VoiceModeActivator {
  const raw = getLocalSetting(LS_VOICE_MODE_ACTIVATION_KEY, "");
  if (!raw) {
    return defaultVoiceModeActivator();
  }
  const activator = parseActivator(raw);
  if (!isValidVoiceModeActivator(activator)) {
    return defaultVoiceModeActivator();
  }
  return activator;
}

export function writeVoiceModeActivator(activator: VoiceModeActivator): void {
  setLocalSetting(LS_VOICE_MODE_ACTIVATION_KEY, serializeActivator(activator));
}

/**
 * Whether this keyboard event satisfies the binding. Shares push to talk's
 * matcher: the difference between the two is what happens next, not what
 * counts as a match.
 */
export function eventMatchesVoiceModeActivator(
  event: KeyboardEvent,
  activator: VoiceModeActivator,
): boolean {
  return eventActivatesPTT(event, activator);
}

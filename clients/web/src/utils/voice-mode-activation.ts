import {
  detectElectronHostOS,
  isMacOSBrowser,
} from "@/runtime/platform-detection";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import {
  type PTTActivator,
  eventActivatesPTT,
  isFnPushToTalkActivator,
  parseActivator,
  serializeActivator,
} from "@/utils/ptt-activator";

/**
 * The binding that starts and ends a live voice session: a keyboard shortcut,
 * or a tap of Fn on a Mac desktop host.
 *
 * Reuses the activator shape push to talk already stores, so the settings
 * recorder, the serialization, and the keyboard matching are shared. Two
 * differences follow from voice mode being a toggle rather than a hold:
 *
 * - Modifier-only bindings are rejected. Holding Ctrl to talk is deliberate;
 *   tapping it is not, so every abandoned Ctrl chord would toggle a session.
 *   Fn is the exception, since a bare Fn tap means nothing else on macOS.
 * - The binding lives under its own storage key. Reusing the push-to-talk key
 *   would silently turn someone's hold-to-dictate binding into a voice toggle.
 */
export type VoiceModeActivator = PTTActivator;

export const LS_VOICE_MODE_ACTIVATION_KEY = "vellum:voice:voiceModeActivation";

/** Whether this activator is the bare Fn tap (desktop hosts only). */
export const isFnVoiceModeActivator = isFnPushToTalkActivator;

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
 * on a host that can see Fn.
 *
 * **Fn is never a default.** It is one key on the user's keyboard, it is not
 * ours, and macOS already gives it away: the Globe key runs whatever "Press 🌐
 * key to" is set to, which on a lot of machines is Start Dictation. Claiming it
 * the moment the app is installed means one press doing two things, only one of
 * which the user asked for, and the app that took it is the one that never
 * asked. It also puts an Input Monitoring prompt in front of someone who has
 * not gone looking for a shortcut. Choosing Fn in Settings is what binds it.
 *
 * A host that can see Fn is the macOS desktop app, where the chord rail is the
 * global Talk shortcut and that ships unbound for its own reasons
 * (`GLOBAL_SHORTCUT_DEFAULTS`). So nothing is bound there until the user says
 * what should be, which is the honest answer rather than a chord this host
 * would not listen for anyway.
 */
export function defaultVoiceModeActivator(
  fnAvailable: boolean,
): VoiceModeActivator {
  return fnAvailable ? { kind: "off" } : keyboardDefaultActivator();
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
 * other than Fn (see the note on {@link VoiceModeActivator}), except on the
 * Windows desktop host, where a bare-modifier tap stands in for Fn.
 */
export function isValidVoiceModeActivator(
  activator: VoiceModeActivator,
): boolean {
  if (activator.kind === "modifierOnly") {
    return isFnVoiceModeActivator(activator) || supportsBareModifierVoiceMode();
  }
  return true;
}

/**
 * The stored binding, or the host default when nothing usable is stored: a
 * modifier-only leftover from the push-to-talk era, or a hand edit, reads as
 * nothing stored rather than as a binding.
 *
 * A stored Fn binding read on a host that cannot see Fn is the one substitution
 * rather than a fall back to the default: the user did ask for a shortcut, and
 * the chord is the same request expressed in something this host can hear.
 */
export function readVoiceModeActivator(
  fnAvailable: boolean,
): VoiceModeActivator {
  const raw = getLocalSetting(LS_VOICE_MODE_ACTIVATION_KEY, "");
  if (!raw) {
    return defaultVoiceModeActivator(fnAvailable);
  }
  const activator = parseActivator(raw, { preserveFunction: fnAvailable });
  if (!isValidVoiceModeActivator(activator)) {
    return defaultVoiceModeActivator(fnAvailable);
  }
  if (isFnVoiceModeActivator(activator) && !fnAvailable) {
    return keyboardDefaultActivator();
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

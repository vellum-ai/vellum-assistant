import { isMacOSBrowser } from "@/runtime/platform-detection";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import {
  FN_PTT_ACTIVATOR,
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

/** The out-of-the-box binding: Fn where the host can see it, else the chord. */
export function defaultVoiceModeActivator(
  fnAvailable: boolean,
): VoiceModeActivator {
  return fnAvailable ? FN_PTT_ACTIVATOR : keyboardDefaultActivator();
}

/**
 * Whether `activator` can bind voice mode. Rejects modifier-only bindings
 * other than Fn; see the note on {@link VoiceModeActivator}.
 */
export function isValidVoiceModeActivator(
  activator: VoiceModeActivator,
): boolean {
  if (activator.kind === "modifierOnly") {
    return isFnVoiceModeActivator(activator);
  }
  return true;
}

/**
 * The stored binding, or the default when nothing is stored. A stored value
 * that binds nothing usable (a modifier-only leftover, or a Fn binding read
 * on a host that cannot see Fn) falls back to the default rather than to
 * "off", so voice mode never becomes unreachable by keyboard.
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

import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router";

import { isTextEntryElement } from "@/domains/chat/composer-focus";
import { isElectron } from "@/runtime/is-electron";
import { toggleVoiceFromSurface } from "@/domains/chat/voice/live-voice/start-voice-request";
import { useNativeChordRegistration } from "@/domains/chat/voice/use-native-chord-registration";
import {
  LS_VOICE_MODE_ACTIVATION_KEY,
  eventMatchesVoiceModeActivator,
  readVoiceModeActivator,
  supportsBareModifierVoiceMode,
  type VoiceModeActivator,
} from "@/utils/voice-mode-activation";
import { type PTTModifier } from "@/utils/ptt-activator";
import type { VoiceModeChord } from "@vellumai/ipc-contract";
import { type HotkeyEvent, subscribeToHotkeyEvents } from "@/runtime/hotkey";
import { watchSetting } from "@/utils/local-settings";

const MODIFIER_BY_KEY: Partial<Record<string, PTTModifier>> = {
  Alt: "option",
  Control: "control",
  Meta: "command",
  Shift: "shift",
};

/**
 * Binds the configured voice mode shortcut (Settings, Voice) to starting and
 * ending a live voice session.
 *
 * **Two transports, split by host, never both at once.**
 *
 * On the desktop app the keyboard binding is an Electron `globalShortcut`
 * ("Talk" in Keyboard Shortcuts), registered by main and delivered as a
 * `toggleVoice` command. A key the OS claims system-wide reaches voice from
 * whatever app the user is actually in, which is where they reach for it, and
 * it never touches the DOM. So this hook binds no chord there: a second,
 * focus-scoped copy of the same shortcut would be a strictly weaker duplicate
 * and would fire twice in the app.
 *
 * Off Electron there is no `globalShortcut`, so the chord is bound here, on
 * `window`. It carries a real modifier and so types nothing, which lets it
 * fire with the composer focused: reaching for voice mid-sentence is the
 * point, and a shortcut that only worked with focus outside the textarea
 * would be dead in the state users are actually in.
 *
 * The macOS desktop app has neither: its voice key (`useVoiceKey`) starts and
 * ends a call on a double tap, and this hook binds nothing there.
 *
 * Starting is not this hook's to define. A press is handed to
 * `toggleVoiceFromSurface`, the same entry the voice key's double tap uses and
 * built on the one the companion surface's Talk uses, so every way in stays
 * one behaviour rather than several.
 */
export function useVoiceModeHotkey({
  enabled = true,
}: { enabled?: boolean } = {}): void {
  const navigate = useNavigate();

  // The Windows analog of the macOS voice key. A bare-modifier binding
  // can only be watched system-wide by the helper's keyboard hook (an Electron
  // `globalShortcut` cannot express one), so it is registered there whenever
  // the setting names one. While the host confirms native capture is live,
  // the DOM tap listener below stays quiet so a focused tap never fires twice.
  const nativeChordRegisteredRef = useRef(false);
  const setNativeChordRegistered = useCallback((registered: boolean) => {
    nativeChordRegisteredRef.current = registered;
  }, []);
  const desiredNativeChord = useCallback((): VoiceModeChord | null => {
    if (!enabled || !supportsBareModifierVoiceMode()) {
      return null;
    }
    const activator = readVoiceModeActivator();
    if (activator.kind !== "modifierOnly") {
      return null;
    }
    return { kind: "modifierOnly", modifiers: activator.modifiers };
  }, [enabled]);
  useNativeChordRegistration(
    desiredNativeChord,
    LS_VOICE_MODE_ACTIVATION_KEY,
    setNativeChordRegistered,
  );

  const toggleVoiceMode = useCallback(() => {
    toggleVoiceFromSurface(navigate);
  }, [navigate]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    let activator = readVoiceModeActivator();
    const unwatchSetting = watchSetting(LS_VOICE_MODE_ACTIVATION_KEY, () => {
      activator = readVoiceModeActivator();
    });

    // A bare-modifier binding (Windows desktop) toggles on a clean tap:
    // press-and-release of exactly the bound modifiers, with nothing else in
    // between. Arming on keydown and firing on keyup is what keeps ordinary
    // chords (Ctrl+C) from toggling a session on their way through.
    const bindsBareModifier = supportsBareModifierVoiceMode();
    let bareTapArmed = false;

    // On the desktop app the chord is an Electron `globalShortcut` that main
    // owns; binding it here as well would fire the same press twice whenever
    // the app happens to be focused.
    const bindsChord = !isElectron();

    const isBareModifierActivator = (a: VoiceModeActivator): boolean =>
      bindsBareModifier && a.kind === "modifierOnly";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || activator.kind === "off") {
        return;
      }
      // Something closer to the user already claimed this key, the terminal
      // taking Ctrl+Shift+V as paste being the case at hand. This listener
      // sits on `window`, so it sees the event after they do; acting anyway
      // would fire both.
      if (event.defaultPrevented) {
        return;
      }
      if (isBareModifierActivator(activator)) {
        if (eventMatchesVoiceModeActivator(event, activator)) {
          bareTapArmed = true;
          // Keep Alt from shifting focus to the menu bar mid-tap.
          event.preventDefault();
        } else {
          bareTapArmed = false;
        }
        return;
      }
      // Desktop chords are the main process's `globalShortcut`; only the
      // bare-modifier path above belongs to the DOM there.
      if (!bindsChord) {
        return;
      }
      // A binding with no modifier is a bare character. Yield to whatever the
      // user is typing it into; everywhere else it is still a shortcut.
      if (
        activator.kind === "key" &&
        activator.modifiers.length === 0 &&
        isTextEntryElement(
          event.target instanceof Element ? event.target : null,
        )
      ) {
        return;
      }
      if (!eventMatchesVoiceModeActivator(event, activator)) {
        return;
      }
      event.preventDefault();
      toggleVoiceMode();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const bound = activator;
      if (
        !bareTapArmed ||
        bound.kind !== "modifierOnly" ||
        !isBareModifierActivator(bound)
      ) {
        return;
      }
      const released = MODIFIER_BY_KEY[event.key];
      if (released === undefined || !bound.modifiers.includes(released)) {
        return;
      }
      bareTapArmed = false;
      event.preventDefault();
      // While the helper's global hook holds this chord, the completed tap
      // arrives over the hotkey bridge below; toggling here too would fire
      // the same press twice whenever the app happens to be focused.
      if (nativeChordRegisteredRef.current) {
        return;
      }
      toggleVoiceMode();
    };

    // A keyup can be lost when focus leaves the window; a stale armed tap
    // would then fire on an unrelated later release.
    const onBlur = () => {
      bareTapArmed = false;
    };

    const onNativeHotkey = (event: HotkeyEvent) => {
      // A completed bare-modifier chord tap from the Windows helper's keyboard
      // hook, reported as a pair once the keys are back up. The release edge
      // means nothing to a toggle, and the tap only counts while the setting
      // still names that binding. The macOS helper's hold edges belong to the
      // voice key.
      if (
        event.kind !== "voiceModeChord" ||
        event.state !== "down" ||
        !isBareModifierActivator(activator)
      ) {
        return;
      }
      toggleVoiceMode();
    };

    // Bare modifiers are the exception to the globalShortcut rule above: a
    // `globalShortcut` cannot express one, so they live on the DOM even there.
    if (bindsChord || bindsBareModifier) {
      window.addEventListener("keydown", onKeyDown);
    }
    if (bindsBareModifier) {
      window.addEventListener("keyup", onKeyUp);
      window.addEventListener("blur", onBlur);
    }
    const unsubscribeHotkeys = subscribeToHotkeyEvents(onNativeHotkey);

    return () => {
      unwatchSetting();
      if (bindsChord || bindsBareModifier) {
        window.removeEventListener("keydown", onKeyDown);
      }
      if (bindsBareModifier) {
        window.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("blur", onBlur);
      }
      unsubscribeHotkeys();
    };
  }, [enabled, toggleVoiceMode]);
}

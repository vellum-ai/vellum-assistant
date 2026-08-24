import { useCallback, useEffect } from "react";
import { useNavigate } from "react-router";

import { isTextEntryElement } from "@/domains/chat/composer-focus";
import { useFnRegistrationStore } from "@/stores/fn-registration-store";
import { isElectron } from "@/runtime/is-electron";
import {
  endLiveVoiceSession,
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { startVoiceFromSurface } from "@/domains/chat/voice/live-voice/start-voice-request";
import { useNativeFnRegistration } from "@/domains/chat/voice/use-native-fn-registration";
import {
  LS_VOICE_MODE_ACTIVATION_KEY,
  eventMatchesVoiceModeActivator,
  isFnVoiceModeActivator,
  readVoiceModeActivator,
  supportsBareModifierVoiceMode,
  type VoiceModeActivator,
} from "@/utils/voice-mode-activation";
import { type PTTModifier } from "@/utils/ptt-activator";
import {
  type HotkeyEvent,
  subscribeToHotkeyEvents,
  supportsFnPushToTalk,
} from "@/runtime/hotkey";
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
 * Fn is desktop-only and orthogonal to both. It never reaches the DOM, so the
 * helper is registered instead. The helper reports a completed bare-Fn tap as
 * a `down`/`up` pair (a chorded Fn press, e.g. Fn+Ctrl or Fn+arrow, is
 * someone else's shortcut and is filtered out there), and the `down` edge is
 * the tap since a toggle has no use for the release. A host that accepts no
 * Fn registration simply has no Fn binding; the global Talk shortcut is still
 * there, and unlike Fn it needs no Input Monitoring grant.
 *
 * Starting is not this hook's to define. A press is handed to
 * `startVoiceFromSurface`, the same entry the companion surface's Talk uses,
 * so every way in stays one behaviour rather than several.
 */
export function useVoiceModeHotkey({
  enabled = true,
}: { enabled?: boolean } = {}): void {
  const navigate = useNavigate();
  /**
   * Publish whether the host took Fn, rather than branching on it here.
   *
   * There is nothing for this hook to do about a refusal: the chord is the
   * host's `globalShortcut` now, so there is no second binding to fall back
   * to, and quietly binding one would be a binding the settings card does not
   * show. What a refusal needs is to be said out loud, which is the card's
   * job. See `fn-registration-store`.
   */
  const setFnRegistered = useFnRegistrationStore(
    (state) => state.setRegistered,
  );

  const shouldRegisterFn = useCallback(
    () =>
      enabled &&
      isFnVoiceModeActivator(readVoiceModeActivator(supportsFnPushToTalk())),
    [enabled],
  );
  useNativeFnRegistration(
    shouldRegisterFn,
    LS_VOICE_MODE_ACTIVATION_KEY,
    setFnRegistered,
  );

  const toggleVoiceMode = useCallback(() => {
    if (isLiveVoiceSessionActive(useLiveVoiceStore.getState().state)) {
      endLiveVoiceSession();
      return;
    }
    // The same action as the companion surface's Talk, deliberately: a press
    // here and a press there are the same request, made from outside the
    // conversation either way. `startVoiceFromSurface` owns what that means,
    // so the two cannot drift.
    startVoiceFromSurface(navigate);
  }, [navigate]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    const fnAvailable = supportsFnPushToTalk();
    let activator = readVoiceModeActivator(fnAvailable);
    const unwatchSetting = watchSetting(LS_VOICE_MODE_ACTIVATION_KEY, () => {
      activator = readVoiceModeActivator(fnAvailable);
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
      bindsBareModifier &&
      a.kind === "modifierOnly" &&
      !isFnVoiceModeActivator(a);

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
      // Fn arrives over the host bridge below, never as a DOM key event.
      if (isFnVoiceModeActivator(activator)) {
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
      toggleVoiceMode();
    };

    // A keyup can be lost when focus leaves the window; a stale armed tap
    // would then fire on an unrelated later release.
    const onBlur = () => {
      bareTapArmed = false;
    };

    const onNativeHotkey = (event: HotkeyEvent) => {
      // The release edge ends a push-to-talk hold. For a toggle it means
      // nothing: the user has already lifted the key that started the session.
      if (event.state !== "down" || !isFnVoiceModeActivator(activator)) {
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

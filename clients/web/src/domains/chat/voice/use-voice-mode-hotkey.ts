import { useCallback, useEffect } from "react";

import { isTextEntryElement } from "@/domains/chat/composer-focus";
import {
  endLiveVoiceSession,
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { useNativeFnRegistration } from "@/domains/chat/voice/use-native-fn-registration";
import {
  LS_VOICE_MODE_ACTIVATION_KEY,
  eventMatchesVoiceModeActivator,
  isFnVoiceModeActivator,
  readVoiceModeActivator,
} from "@/utils/voice-mode-activation";
import {
  type HotkeyEvent,
  subscribeToHotkeyEvents,
  supportsFnPushToTalk,
} from "@/runtime/hotkey";
import { watchSetting } from "@/utils/local-settings";

/**
 * Start or end a session through the seams the visible composer registers, so
 * a shortcut start runs the same preflight, first-run card, and entry-origin
 * animation as its voice button. No composer registered means nothing to
 * start, which is the right answer: there is no chat to talk to.
 */
function toggleVoiceMode(): void {
  const { state, entryHandler } = useLiveVoiceStore.getState();
  if (isLiveVoiceSessionActive(state)) {
    endLiveVoiceSession();
    return;
  }
  entryHandler?.();
}

/**
 * Binds the configured voice mode shortcut (Settings → Voice) to starting and
 * ending a live voice session.
 *
 * Unlike the chat layout's other shortcuts, this one deliberately fires with
 * the composer focused. The binding is a chord with a real modifier, so it
 * types nothing, and reaching for voice mid-sentence is the whole point — a
 * shortcut that only worked with focus outside the textarea would be dead in
 * the state users are actually in.
 *
 * Fn never reaches the DOM. When the binding is Fn, the desktop helper is
 * registered instead and its `down` edge is the tap: the helper reports a
 * hold (`down`/`up`) because push to talk needed both, and voice mode simply
 * ignores the release.
 */
export function useVoiceModeHotkey({
  enabled = true,
}: { enabled?: boolean } = {}): void {
  const shouldRegisterFn = useCallback(
    () =>
      enabled &&
      isFnVoiceModeActivator(readVoiceModeActivator(supportsFnPushToTalk())),
    [enabled],
  );
  useNativeFnRegistration(shouldRegisterFn, LS_VOICE_MODE_ACTIVATION_KEY);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    const fnAvailable = supportsFnPushToTalk();
    let activator = readVoiceModeActivator(fnAvailable);
    const unwatchSetting = watchSetting(LS_VOICE_MODE_ACTIVATION_KEY, () => {
      activator = readVoiceModeActivator(fnAvailable);
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || activator.kind === "off") {
        return;
      }
      // Something closer to the user already claimed this key — the terminal
      // taking Ctrl+Shift+V as paste, say. This listener sits on `window`, so
      // it sees the event after they do; acting anyway would fire both.
      if (event.defaultPrevented) {
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

    const onNativeHotkey = (event: HotkeyEvent) => {
      // The release edge ends a push-to-talk hold. For a toggle it means
      // nothing: the user has already lifted the key that started the session.
      if (event.state !== "down" || !isFnVoiceModeActivator(activator)) {
        return;
      }
      toggleVoiceMode();
    };

    window.addEventListener("keydown", onKeyDown);
    const unsubscribeHotkeys = subscribeToHotkeyEvents(onNativeHotkey);

    return () => {
      unwatchSetting();
      window.removeEventListener("keydown", onKeyDown);
      unsubscribeHotkeys();
    };
  }, [enabled]);
}

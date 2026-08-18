import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { isTextEntryElement } from "@/domains/chat/composer-focus";
import {
  endLiveVoiceSession,
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { requestVoiceModeStart } from "@/domains/chat/voice/pending-voice-start";
import { useNativeFnRegistration } from "@/domains/chat/voice/use-native-fn-registration";
import {
  LS_VOICE_MODE_ACTIVATION_KEY,
  eventMatchesVoiceModeActivator,
  isFnVoiceModeActivator,
  keyboardDefaultActivator,
  readVoiceModeActivator,
} from "@/utils/voice-mode-activation";
import {
  type HotkeyEvent,
  subscribeToHotkeyEvents,
  supportsFnPushToTalk,
} from "@/runtime/hotkey";
import { watchSetting } from "@/utils/local-settings";
import { useConversationStore } from "@/stores/conversation-store";
import { routes } from "@/utils/routes";

/**
 * Binds the configured voice mode shortcut (Settings, Voice) to starting and
 * ending a live voice session.
 *
 * Unlike the chat layout's other shortcuts, this one fires with the composer
 * focused. The binding is a chord with a real modifier, so it types nothing,
 * and reaching for voice mid-sentence is the point: a shortcut that only
 * worked with focus outside the textarea would be dead in the state users are
 * actually in.
 *
 * Fn never reaches the DOM. When the binding is Fn the desktop helper is
 * registered instead and its `down` edge is the tap, since the helper reports
 * a hold (`down`/`up`) and a toggle has no use for the release. A host that
 * accepts no Fn registration falls back to the keyboard chord, so the
 * shortcut stays reachable without Input Monitoring.
 */
export function useVoiceModeHotkey({
  enabled = true,
}: { enabled?: boolean } = {}): void {
  const navigate = useNavigate();
  const [fnRegistered, setFnRegistered] = useState(true);

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

  /**
   * Start through the seam the visible composer registers, so a shortcut
   * start runs the same preflight, first-run card, and entry-origin animation
   * as its voice button. Off a chat route no composer is mounted, so the
   * request is parked and the conversation surface brought up to serve it.
   */
  const startVoiceMode = useCallback(() => {
    const { entryHandler } = useLiveVoiceStore.getState();
    if (entryHandler) {
      entryHandler();
      return;
    }
    requestVoiceModeStart();
    const conversationId = useConversationStore.getState().activeConversationId;
    navigate(
      conversationId ? routes.conversation(conversationId) : routes.assistant,
    );
  }, [navigate]);

  const toggleVoiceMode = useCallback(() => {
    if (isLiveVoiceSessionActive(useLiveVoiceStore.getState().state)) {
      endLiveVoiceSession();
      return;
    }
    startVoiceMode();
  }, [startVoiceMode]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    const fnAvailable = supportsFnPushToTalk();
    /**
     * The binding as it can actually be delivered. A stored Fn binding on a
     * host that rejected the registration is inert (the DOM never sees Fn),
     * so it resolves to the chord instead of to nothing.
     */
    const resolveActivator = () => {
      const stored = readVoiceModeActivator(fnAvailable);
      if (isFnVoiceModeActivator(stored) && !fnRegistered) {
        return keyboardDefaultActivator();
      }
      return stored;
    };

    let activator = resolveActivator();
    const unwatchSetting = watchSetting(LS_VOICE_MODE_ACTIVATION_KEY, () => {
      activator = resolveActivator();
    });

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
  }, [enabled, fnRegistered, toggleVoiceMode]);
}

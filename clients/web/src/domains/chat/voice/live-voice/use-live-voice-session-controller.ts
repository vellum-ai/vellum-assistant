/**
 * `useLiveVoiceSessionController()` — persistent owner of the live-voice
 * session controller.
 *
 * Mounted once by `ChatLayout`, which stays mounted across every chat-side
 * child route (conversations, home, library, identity, documents, the
 * fullscreen app viewer, …). Because {@link useLiveVoice} tears the session
 * down when its owner unmounts, the hook must live at this layout scope — a
 * composer-owned controller would kill the mic/socket on exactly the
 * navigations the title-bar session pill exists for.
 *
 * Routes outside the chat layout (settings, logs, account) unmount this hook
 * and therefore end any active session. That is deliberate: no session
 * control surface (composer bar or title-bar pill) exists there, and a live
 * microphone must never outlive its last visible control.
 *
 * The hook renders nothing and exposes nothing. Surfaces interact with the
 * session exclusively through `useLiveVoiceStore`:
 *
 * - `starter` — registered here for the lifetime of the mount; the composer's
 *   entry-point mic calls it to start a session. Registering it also drains any
 *   start-voice deep link parked before this mount (see
 *   `start-voice-deep-link.ts`).
 * - `controls` (stop/release/interrupt) — registered per-session by
 *   {@link useLiveVoice} itself.
 * - `state`/`error`/transcripts/amplitude — observable session state.
 *
 * It is also where optional native voice accessories are bound to the session:
 * audio focus ({@link useNativeAudioSessionLifecycle}) and the platform status
 * surface ({@link useLiveActivityMirror}).
 */

import { useEffect } from "react";

import {
  useLiveVoice,
  type UseLiveVoiceOptions,
} from "@/domains/chat/voice/live-voice/use-live-voice";
import {
  endLiveVoiceSession,
  isLiveVoiceSessionActive,
  subscribeSettledLiveVoiceState,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { drainPendingVoiceStartDeepLink } from "@/domains/chat/voice/live-voice/start-voice-deep-link";
import { useLiveActivityMirror } from "@/domains/chat/voice/live-voice/use-live-activity-mirror";
import {
  activateVoiceAudioSession,
  deactivateVoiceAudioSession,
  subscribeVoiceAudioInterruptions,
} from "@/runtime/native-audio-session";
import { isNativeAndroid } from "@/runtime/platform-detection";

/** Injectable primitive factories, for tests. */
export type UseLiveVoiceSessionControllerOptions = Pick<
  UseLiveVoiceOptions,
  "createClient" | "createCapture" | "createPlayer"
>;

/**
 * Own Android audio focus and report native audio interruptions into voice.
 *
 * Android focus follows settled session state and is serialized so a delayed
 * activation cannot outlive the session that requested it. iOS still never
 * calls `activate()`: WebKit owns its shared `AVAudioSession`, and activating a
 * second owner has broken foreground capture on physical handsets.
 */
function useNativeAudioSessionLifecycle(): void {
  useEffect(() => {
    let wantsAudioFocus = false;
    let hasAudioFocus = false;
    let reconcilingAudioFocus = false;
    let reconcileRequested = false;
    let activationAttempts = 0;
    let lastSettledState = useLiveVoiceStore.getState().state;

    const reconcileAudioFocus = async (): Promise<void> => {
      if (reconcilingAudioFocus) {
        reconcileRequested = true;
        return;
      }
      reconcilingAudioFocus = true;
      reconcileRequested = false;
      try {
        while (wantsAudioFocus !== hasAudioFocus) {
          if (wantsAudioFocus) {
            if (activationAttempts >= 2) {
              return;
            }
            activationAttempts += 1;
            hasAudioFocus = await activateVoiceAudioSession();
            if (!hasAudioFocus) {
              return;
            }
          } else {
            await deactivateVoiceAudioSession();
            hasAudioFocus = false;
          }
        }
      } finally {
        reconcilingAudioFocus = false;
        if (reconcileRequested && wantsAudioFocus !== hasAudioFocus) {
          void reconcileAudioFocus();
        }
      }
    };

    const syncAudioFocus = (): void => {
      const settledState = useLiveVoiceStore.getState().state;
      const stateChanged = settledState !== lastSettledState;
      lastSettledState = settledState;
      const nextWantsAudioFocus = isLiveVoiceSessionActive(
        settledState,
      );
      activationAttempts = nextWantsAudioFocus ? activationAttempts : 0;
      if (
        nextWantsAudioFocus === wantsAudioFocus &&
        (!stateChanged || hasAudioFocus)
      ) {
        return;
      }
      wantsAudioFocus = nextWantsAudioFocus;
      void reconcileAudioFocus();
    };

    const managesAudioFocus = isNativeAndroid();
    const unsubscribeAudioFocus = managesAudioFocus
      ? subscribeSettledLiveVoiceState(syncAudioFocus)
      : () => undefined;
    if (managesAudioFocus) {
      syncAudioFocus();
    }

    const unsubscribeInterruptions = subscribeVoiceAudioInterruptions(
      (event) => {
        // A phone call or Siri has taken the mic. End the session rather than
        // leave it "listening" into a dead input. No auto-resume on `ended`:
        // the user restarts explicitly.
        if (event.type !== "began" || event.reason === "route-change") {
          return;
        }
        if (!isLiveVoiceSessionActive(useLiveVoiceStore.getState().state)) {
          return;
        }
        endLiveVoiceSession();
      },
    );

    return () => {
      unsubscribeAudioFocus();
      unsubscribeInterruptions();
      wantsAudioFocus = false;
      void reconcileAudioFocus();
    };
  }, []);
}

export function useLiveVoiceSessionController(
  options: UseLiveVoiceSessionControllerOptions = {},
): void {
  // `observeAudioState: false` — the controller consumes nothing reactive
  // beyond the low-frequency `state`/`error` fields, so high-frequency
  // amplitude/transcript updates must not re-render the mounting layout.
  const { start, prewarmPlayback, cancelPrewarmedPlayback } = useLiveVoice({
    ...options,
    observeAudioState: false,
  });

  useEffect(() => {
    useLiveVoiceStore.getState().setStarter({
      prewarm: prewarmPlayback,
      cancelPrewarm: cancelPrewarmedPlayback,
      start: (assistantId, conversationId) =>
        // Hands-free (server-side turn detection) is the only mode the voice
        // button starts — it keeps one socket open across turns so the
        // assistant's TTS drains instead of the session tearing down each
        // turn. Manual single-turn survives only as the version-skew fallback
        // when the daemon's `ready` doesn't echo `server_vad`.
        void start(assistantId, conversationId ?? undefined, {
          handsFree: true,
        }),
    });
    // A start-voice deep link that arrived before this mount (cold launch from
    // Siri / the Action Button / a Live Activity tap) is parked; now that a
    // starter exists, run it. One-shot, so the re-runs of this effect are free.
    void drainPendingVoiceStartDeepLink();
    return () => {
      useLiveVoiceStore.getState().setStarter(null);
    };
  }, [start, prewarmPlayback, cancelPrewarmedPlayback]);

  useNativeAudioSessionLifecycle();
  useLiveActivityMirror();
}

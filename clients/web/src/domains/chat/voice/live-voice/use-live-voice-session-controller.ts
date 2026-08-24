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
 *   `start-voice-request.ts`), as does a change of active assistant, which is
 *   the other thing that can make a parked request drainable.
 * - `controls` (stop/release/interrupt) — registered per-session by
 *   {@link useLiveVoice} itself.
 * - `state`/`error`/transcripts/amplitude — observable session state.
 *
 * It is also where optional native voice accessories are bound to the session:
 * audio focus ({@link useNativeAudioSessionLifecycle}) and both halves of the
 * platform status surface — what it shows ({@link useLiveActivityMirror}) and
 * what its buttons do ({@link useLiveActivityControls}).
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import { useNavigate } from "react-router";

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
import { drainPendingVoiceStart } from "@/domains/chat/voice/live-voice/start-voice-request";
import { useLiveActivityControls } from "@/domains/chat/voice/live-voice/use-live-activity-controls";
import { useLiveActivityMirror } from "@/domains/chat/voice/live-voice/use-live-activity-mirror";
import {
  activateVoiceAudioSession,
  deactivateVoiceAudioSession,
  subscribeVoiceAudioInterruptions,
} from "@/runtime/native-audio-session";
import { isNativeAndroid } from "@/runtime/platform-detection";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

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
    let activationInFlight = false;
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
            activationInFlight = true;
            hasAudioFocus = await activateVoiceAudioSession();
            activationInFlight = false;
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
      const settledSession = useLiveVoiceStore.getState();
      const settledState = settledSession.state;
      const stateChanged = settledState !== lastSettledState;
      lastSettledState = settledState;
      const nextWantsAudioFocus =
        isLiveVoiceSessionActive(settledState) &&
        (settledSession.microphoneActive ||
          hasAudioFocus ||
          activationInFlight);
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

  // A parked start-voice request is drained here, and the drain lands on the
  // conversation it mints for the session (see `start-voice-request.ts`). Held
  // in a ref, and read only when the drain gets that far, so a fresh
  // `navigate` identity never re-registers the starter.
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useLayoutEffect(() => {
    navigateRef.current = navigate;
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
    void drainPendingVoiceStart((to, navigateOptions) =>
      navigateRef.current(to, navigateOptions),
    );
    return () => {
      useLiveVoiceStore.getState().setStarter(null);
    };
  }, [start, prewarmPlayback, cancelPrewarmedPlayback]);

  // The drain's second trigger, and the only one a parked request has once the
  // starter is registered: the effect above runs on the starter's identity, not
  // on anything the drain gates against. `drainPendingVoiceStart` reparks when
  // the active assistant changed under a preflight, because the eligibility
  // gate and the readiness verdict both answered for the assistant the user
  // just left, and without this that request would sit until its TTL took it.
  //
  // This fires on the resolved-assistants change, which is ahead of the
  // identity store being cleared and rehydrated for the assistant switched to.
  // The drain waits that out itself, on a wait scoped to the new assistant, so
  // it decides on the identity of the one the user moved to rather than on the
  // version still held for the one they left.
  //
  // Subscribed rather than selected, so a switch never re-renders the mounting
  // layout, matching `observeAudioState: false` above. Nothing here starts a
  // session on its own: a drain with nothing parked returns immediately, and
  // the park is one-shot, so a drain that overlaps one already in flight loses
  // the consume and stops.
  useEffect(() => {
    return useResolvedAssistantsStore.subscribe((state, prevState) => {
      if (state.activeAssistantId === prevState.activeAssistantId) {
        return;
      }
      void drainPendingVoiceStart((to, navigateOptions) =>
        navigateRef.current(to, navigateOptions),
      );
    });
  }, []);

  useNativeAudioSessionLifecycle();
  useLiveActivityMirror();
  // The island's inbound half. Separate from the mirror because it reaches the
  // session and the mirror may not; see `use-live-activity-controls.ts`.
  useLiveActivityControls();
}

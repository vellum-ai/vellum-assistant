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
 * It is also where the iOS-native mirrors of the session are bound to its
 * lifecycle — the audio session ({@link useNativeAudioSessionLifecycle}) and
 * the Live Activity ({@link useLiveActivityMirror}). Both are inert off the
 * iOS shell.
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
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { drainPendingVoiceStartDeepLink } from "@/domains/chat/voice/live-voice/start-voice-deep-link";
import { useLiveActivityMirror } from "@/domains/chat/voice/live-voice/use-live-activity-mirror";
import {
  activateVoiceAudioSession,
  deactivateVoiceAudioSession,
  subscribeVoiceAudioInterruptions,
} from "@/runtime/native-audio-session";

/** Injectable primitive factories, for tests. */
export type UseLiveVoiceSessionControllerOptions = Pick<
  UseLiveVoiceOptions,
  "createClient" | "createCapture" | "createPlayer"
>;

/**
 * Hold the native iOS audio session open for exactly as long as a live-voice
 * session is running.
 *
 * Driven off store *phase transitions* rather than off the `starter`, so
 * sessions begun from any surface — the composer mic, a start-voice deep link,
 * a reconnect — are covered symmetrically, and so `failed` releases the audio
 * session just as `idle` does.
 *
 * Everything runs through {@link subscribeSettledLiveVoiceState} inside an
 * effect, never a reactive selector in a render body: the controller sets
 * `observeAudioState: false` precisely so high-frequency amplitude/transcript
 * updates do not re-render the mounting layout, and reading `state` reactively
 * here would subscribe the layout to session churn all over again. Settled
 * rather than raw because a reconnect passes through `idle` on its way back to
 * `connecting` within one tick, and tearing the audio session down and back up
 * on every retry is exactly what the `audio` background mode exists to prevent.
 *
 * Off the iOS shell every call is a no-op (see `runtime/native-audio-session`),
 * so this is inert in the browser and on Electron.
 *
 * **This is the riskiest call in the iOS voice feature — do not change it
 * without a handset.** WebKit owns the shared `AVAudioSession` backing
 * `getUserMedia` in a `WKWebView`, so activating our own around a live capture
 * unit is what `docs/CAPACITOR.md` § "Full-duplex TTS must render through a
 * MediaStream track" warns about: the same pattern shipped as #39331, produced
 * no capture at all, and was reverted in #39345.
 *
 * Two things keep it in the tree anyway. Activation happens once, at the
 * session's leading edge, never re-asserted mid-session (the re-assert was the
 * prime suspect in #39331) — that is what `holdingAudioSession` guarantees. And
 * echo cancellation no longer rides on it at all: #39347 gets AEC from WebKit's
 * own voice-processing unit via a `MediaStreamAudioDestinationNode`, so the only
 * thing left on this call is background/lock-screen audio.
 *
 * **The Simulator cannot evaluate any of that** — its mock audio device has no
 * acoustic path, so it passes whether or not a real handset would go silent.
 * Every Simulator run passed during #39331.
 */
function useNativeAudioSessionLifecycle(): void {
  useEffect(() => {
    // Mirrors whether we currently hold the native audio session, so activate
    // fires once per session — not once per `listening`/`thinking`/`speaking`
    // transition — and deactivate never double-fires.
    let holdingAudioSession = false;

    const sync = (state: LiveVoiceSessionState): void => {
      const active = isLiveVoiceSessionActive(state);
      if (active === holdingAudioSession) {
        return;
      }
      holdingAudioSession = active;
      void (active
        ? activateVoiceAudioSession()
        : deactivateVoiceAudioSession());
    };

    // A session can already be running when this mounts (the controller
    // remounts across layout-level route changes while the store persists).
    sync(useLiveVoiceStore.getState().state);
    const unsubscribeStore = subscribeSettledLiveVoiceState((s) =>
      sync(s.state),
    );

    const unsubscribeInterruptions = subscribeVoiceAudioInterruptions(
      (event) => {
        if (event.type !== "began") {
          return;
        }
        // Only `default` means the microphone actually went away (a phone
        // call, Siri, another app). End that session rather than leave it
        // "listening" into a dead input. No auto-resume on `ended`: the user
        // restarts explicitly.
        //
        // Every other reason interrupts without taking the input: headphones
        // unplugged, an iPad's Smart Folio closing. Those keep running, and
        // the native side reactivates the audio session on `ended` so what
        // they keep is live. `unknown` (an unrecognized reason, or a shell
        // that sends none) is deliberately on the keep side: ending is the
        // destructive move, so it needs the platform to have actually said
        // the input is gone.
        if (event.reason !== "default") {
          return;
        }
        if (!isLiveVoiceSessionActive(useLiveVoiceStore.getState().state)) {
          return;
        }
        endLiveVoiceSession();
      },
    );

    return () => {
      unsubscribeStore();
      unsubscribeInterruptions();
      // A live audio session must never outlive its controller. Usually the
      // sibling teardown in `useLiveVoice` has already reset the store to
      // `idle` (which `sync` observed), leaving this a no-op; it covers the
      // orders where it has not.
      if (holdingAudioSession) {
        holdingAudioSession = false;
        void deactivateVoiceAudioSession();
      }
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

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
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { drainPendingVoiceStartDeepLink } from "@/domains/chat/voice/live-voice/start-voice-deep-link";
import { useLiveActivityMirror } from "@/domains/chat/voice/live-voice/use-live-activity-mirror";
import {
  subscribeVoiceAudioInterruptions,
} from "@/runtime/native-audio-session";

/** Injectable primitive factories, for tests. */
export type UseLiveVoiceSessionControllerOptions = Pick<
  UseLiveVoiceOptions,
  "createClient" | "createCapture" | "createPlayer"
>;

/**
 * Report native `AVAudioSession` interruptions into the live-voice session.
 *
 * **This deliberately no longer activates an audio session of its own.**
 * WebKit owns the shared `AVAudioSession` backing `getUserMedia` in a
 * `WKWebView`, and activating ours alongside it is what `docs/CAPACITOR.md`
 * § "Full-duplex TTS must render through a MediaStream track" warns about. That
 * pattern has now broken live voice on a handset twice: first as #39331, which
 * produced no capture at all and was reverted in #39345, and again when it
 * returned in #39306, where a session died roughly 60ms after its socket
 * opened. The second failure took a while to attribute because #39306's uploads
 * were all rejected by App Store Connect until #39556, so the plugin had never
 * actually run on a device before.
 *
 * Nothing else depended on it. Echo cancellation moved to WebKit's own
 * voice-processing unit in #39347 via a `MediaStreamAudioDestinationNode`, and
 * background/lock-screen audio is claimed by `UIBackgroundModes: audio` in
 * `Info.plist`, which is independent of this call. Whether the plist entry
 * alone actually sustains a backgrounded session is still unmeasured (see the
 * background-audio contract in `docs/CAPACITOR.md`), but a session that dies
 * immediately in the foreground is strictly worse than one that may not survive
 * backgrounding.
 *
 * The interruption subscription stays. It listens to
 * `AVAudioSession.sharedInstance()`, so it still hears a phone call or Siri
 * taking the input from WebKit's session, and ending on that is unrelated to
 * owning a session ourselves.
 *
 * Off the iOS shell this is a no-op (see `runtime/native-audio-session`), so it
 * is inert in the browser and on Electron.
 *
 * **The Simulator cannot evaluate any of this.** Its mock audio device has no
 * acoustic path, so it passes whether or not a real handset would go silent.
 * Every Simulator run passed during #39331, and the Simulator sustained a
 * session normally throughout the #39306 failure too.
 */
function useNativeAudioSessionLifecycle(): void {
  useEffect(() => {
    const unsubscribeInterruptions = subscribeVoiceAudioInterruptions(
      (event) => {
        // A phone call or Siri has taken the mic. End the session rather than
        // leave it "listening" into a dead input. No auto-resume on `ended`:
        // the user restarts explicitly.
        if (event.type !== "began") {
          return;
        }
        if (!isLiveVoiceSessionActive(useLiveVoiceStore.getState().state)) {
          return;
        }
        endLiveVoiceSession();
      },
    );

    return unsubscribeInterruptions;
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

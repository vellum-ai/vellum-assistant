/**
 * JS ↔ native bridge for the `VoiceAudioSession` Capacitor plugin registered by
 * `clients/ios/App/App/MyViewController.swift` +
 * `clients/ios/App/App/VoiceAudioSessionPlugin.swift`.
 *
 * The plugin owns the app's `AVAudioSession` for the duration of a live-voice
 * session: `.playAndRecord` / `.voiceChat` (hardware echo cancellation, AGC,
 * correct AirPods/Bluetooth-HFP routing) plus the `audio` background mode, so
 * TTS keeps playing and the mic keeps its route while the app is backgrounded
 * or the screen is locked. Deactivating passes `.notifyOthersOnDeactivation`
 * so whatever the user was listening to before resumes.
 *
 * **Skew contract.** The iOS shell ships through App Store review while this
 * bundle deploys continuously (`clients/ios/README.md` § "Web content
 * delivery"), so an arbitrarily old shell may host this bundle with no such
 * plugin compiled in. Every call therefore goes through
 * {@link callNativeVoice}, which returns the fallback off-iOS and on any bridge
 * failure: without the plugin a voice session behaves exactly as it does today,
 * losing only the background/route niceties. Nothing here may throw, and
 * nothing here may block a session.
 *
 * There is no separate `isAvailable` probe: {@link activateVoiceAudioSession}
 * resolving `false` *is* the probe, and it is the only answer a caller can act
 * on anyway.
 *
 * References:
 * - https://developer.apple.com/documentation/avfaudio/avaudiosession
 * - https://developer.apple.com/documentation/avfaudio/avaudiosession/mode/1616455-voicechat
 */

import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

import { callNativeVoice } from "@/runtime/native-voice";
import { isNativeIOS } from "@/runtime/platform-detection";

/**
 * An `AVAudioSession` interruption — something else took the audio hardware.
 *
 * - `began` — a phone call, a Siri invocation, or another app grabbed the mic.
 * - `ended` — the interrupting activity finished. `shouldResume` mirrors
 *   Apple's `.shouldResume` option; we deliberately do not act on it (see
 *   {@link subscribeVoiceAudioInterruptions}).
 */
export interface VoiceAudioInterruptionEvent {
  type: "began" | "ended";
  shouldResume: boolean;
}

/**
 * An `AVAudioSession` route change (AirPods connected/removed, …). The plugin
 * emits these; nothing consumes them yet, so no subscriber is exported.
 */
interface VoiceAudioRouteChangeEvent {
  reason: string;
}

interface VoiceAudioSessionPlugin {
  activate(): Promise<{ activated: boolean }>;
  deactivate(): Promise<void>;
  addListener(
    eventName: "voiceAudioInterruption",
    handler: (event: VoiceAudioInterruptionEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "voiceAudioRouteChange",
    handler: (event: VoiceAudioRouteChangeEvent) => void,
  ): Promise<PluginListenerHandle>;
}

const VoiceAudioSession =
  registerPlugin<VoiceAudioSessionPlugin>("VoiceAudioSession");

/**
 * Configure and activate the audio session for a live-voice session. Resolves
 * `true` when the native side took over, `false` on every other platform and
 * on any bridge failure (an older shell without the plugin).
 *
 * Call it when a session becomes active, and pair every call with
 * {@link deactivateVoiceAudioSession} — an audio session that outlives its
 * voice session holds the mic route and keeps other apps' audio ducked.
 */
export async function activateVoiceAudioSession(): Promise<boolean> {
  return callNativeVoice(async () => {
    // Only the result crosses this `async` boundary, never `VoiceAudioSession`
    // itself: per `docs/CAPACITOR.md` § "Capacitor plugins must be destructured
    // inline", a plugin Proxy in a Promise-resolution context dispatches a
    // native `then()` that never resolves and hangs the caller forever.
    const { activated } = await VoiceAudioSession.activate();
    // Normalized rather than returned raw — the bridge payload is untyped at
    // runtime, and a shell that answers `{}` must read as "not activated".
    return activated === true;
  }, false);
}

/**
 * Release the audio session at the end of a live-voice session. No-op off-iOS
 * and on an older shell. Never throws.
 */
export async function deactivateVoiceAudioSession(): Promise<void> {
  return callNativeVoice(async () => {
    await VoiceAudioSession.deactivate();
  }, undefined);
}

/**
 * Subscribe to `AVAudioSession` interruptions, returning an unsubscribe.
 *
 * Consumers should end the voice session on `type: "began"` — the mic is gone,
 * and a session that silently keeps "listening" into a dead input is worse than
 * one that ends. Do NOT auto-resume on `ended`: the user restarts explicitly.
 *
 * `addListener` is one of the few property names the Capacitor plugin Proxy
 * does *not* trap into a fabricated native method, so calling it on a plugin
 * the shell never registered is safe — it simply never fires. The
 * `isNativeIOS()` guard still short-circuits everywhere else for the same
 * reason as {@link callNativeVoice}: off the iOS shell there is no native side
 * to listen to.
 *
 * Registration is asynchronous, so an unsubscribe that beats it removes the
 * handle on arrival rather than leaking it. This deliberately does not reuse
 * `subscribeCapacitorListener`: that scaffold reports failures through
 * `captureError`, and a missing plugin on a skewed shell is an expected state
 * on every web deploy, not a fault worth a Sentry event.
 */
export function subscribeVoiceAudioInterruptions(
  handler: (event: VoiceAudioInterruptionEvent) => void,
): () => void {
  if (!isNativeIOS()) {
    return () => undefined;
  }

  let handle: PluginListenerHandle | null = null;
  let cancelled = false;

  VoiceAudioSession.addListener("voiceAudioInterruption", handler)
    .then((registered) => {
      if (cancelled) {
        void registered.remove();
        return;
      }
      handle = registered;
    })
    .catch((err: unknown) => {
      console.debug(
        "[native-audio-session] interruption listener failed:",
        err,
      );
    });

  return () => {
    cancelled = true;
    void handle?.remove();
    handle = null;
  };
}

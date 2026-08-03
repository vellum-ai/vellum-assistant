/**
 * JS to native bridge for the optional `VoiceAudioSession` Capacitor plugin.
 *
 * Android uses it to hold interactive voice audio focus while the foreground
 * WebView owns capture and playback. The shipped iOS methods and payloads stay
 * unchanged, but iOS activation remains disabled at its production caller due
 * to the handset regression documented in `docs/CAPACITOR.md`.
 *
 * Every call goes through {@link callNativeVoice}. Browsers and older native
 * shells keep the existing no-op behavior.
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

import {
  callNativeVoice,
  subscribeNativeVoiceListener,
} from "@/runtime/native-voice";

/**
 * Shared audio event payload. `reason` is optional so existing iOS shells that
 * emit only `{ type }` remain compatible.
 */
export interface VoiceAudioInterruptionEvent {
  type: "began" | "ended";
  reason?: "interruption" | "focus-loss" | "route-change" | "resume";
}

interface VoiceAudioSessionPlugin {
  activate(): Promise<{ activated: boolean }>;
  deactivate(): Promise<void>;
  addListener(
    eventName: "voiceAudioInterruption",
    handler: (event: VoiceAudioInterruptionEvent) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

const VoiceAudioSession =
  registerPlugin<VoiceAudioSessionPlugin>("VoiceAudioSession");

/**
 * Configure and activate the audio session for a live-voice session. Resolves
 * `true` when the native side took over, `false` outside a supported native
 * shell or on any bridge failure.
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
 * Release native audio ownership. No-op in browsers and older shells.
 */
export async function deactivateVoiceAudioSession(): Promise<void> {
  return callNativeVoice(async () => {
    await VoiceAudioSession.deactivate();
  }, undefined);
}

/**
 * Subscribe to native interruption, focus, and resume events.
 *
 * Consumers should end the voice session on `type: "began"` unless the reason
 * is `route-change`. Route changes preserve the live media tracks. Do not
 * auto-resume on `ended`; the user restarts explicitly.
 *
 * Registration is asynchronous, so an unsubscribe that beats it removes the
 * handle on arrival rather than leaking it.
 */
export function subscribeVoiceAudioInterruptions(
  handler: (event: VoiceAudioInterruptionEvent) => void,
): () => void {
  return subscribeNativeVoiceListener(
    () => VoiceAudioSession.addListener("voiceAudioInterruption", handler),
    "native-audio-session",
  );
}

import { registerPlugin } from "@capacitor/core";

import { isNativePlatform } from "@/runtime/native-auth";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/**
 * JS ↔ native bridge for the `VoiceAudioSession` Capacitor plugin registered by
 * `clients/ios/App/App/MyViewController.swift` +
 * `clients/ios/App/App/VoiceAudioSessionPlugin.swift`.
 *
 * Puts the iOS app's `AVAudioSession` into `.playAndRecord` / `.voiceChat` for
 * the duration of a live-voice session so the platform runs acoustic echo
 * cancellation against our own TTS (JARVIS-1364) — the `echoCancellation: true`
 * constraint in `utils/voice-input-device.ts` is not enough on its own inside a
 * WKWebView, because the canceller WebKit gets is chosen by the app's audio
 * session.
 *
 * ## Default OFF, and why the gate is here rather than in Swift
 *
 * The first attempt at this shipped unconditionally and stopped the microphone
 * picking up any audio on device (build `202607281114`); the Simulator could
 * not have caught it, because it feeds a synthetic `Mock audio device` with no
 * real audio unit behind it. The native half ships inside the app binary, so a
 * native-side gate would need an App Store / TestFlight release to flip. This
 * web-side gate hot-loads with the bundle, which makes it a genuine kill
 * switch and lets the configuration be iterated on a real device without
 * cutting a build.
 *
 * To try it on a device, set the local override in the WKWebView console:
 *
 *     localStorage.setItem("vellum:ff:ios-voice-audio-session", "true")
 *
 * ## Failure policy
 *
 * Nothing in here may throw or reject. `LiveVoiceAudioCapture.start()` is
 * documented never to throw — `use-live-voice.ts` awaits its promise with no
 * catch — so an exception escaping this module takes the whole live-voice
 * session down rather than degrading to "no echo cancellation".
 */

interface VoiceAudioSessionPlugin {
  activate(): Promise<void>;
  deactivate(): Promise<void>;
}

const VoiceAudioSession =
  registerPlugin<VoiceAudioSessionPlugin>("VoiceAudioSession");

/** Store key for the `ios-voice-audio-session` client flag (kebab → camel). */
const FLAG_KEY = "iosVoiceAudioSession";

/**
 * Whether to touch the audio session at all. Read non-reactively — the callers
 * are capture lifecycle methods, not React render bodies.
 *
 * Deliberately does *not* wait on `hydrated`: capture must not block on an LD
 * fetch, and the registry default (off) plus any local override is the right
 * answer for a cold start. A flag that flips to on mid-session takes effect on
 * the next session.
 */
function isEnabled(): boolean {
  try {
    if (!isNativePlatform()) return false;
    return useClientFeatureFlagStore.getState()[FLAG_KEY] === true;
  } catch {
    return false;
  }
}

/** `isNativePlatform()` behind the same never-throws guarantee. */
function onNativeShell(): boolean {
  try {
    return isNativePlatform();
  } catch {
    return false;
  }
}

/**
 * Configure and activate the voice-chat audio session, before the mic is
 * opened: the category and mode in force when WebKit builds its capture unit
 * are what decide whether the platform echo canceller runs at all.
 *
 * Resolves regardless of outcome.
 */
export async function activateVoiceAudioSession(): Promise<void> {
  if (!isEnabled()) return;
  try {
    await VoiceAudioSession.activate();
  } catch (err) {
    console.error("[voice-audio-session] activate failed:", err);
  }
}

/**
 * Restore the pre-session audio configuration and release the session. Safe to
 * call without a matching `activate()` — the native side no-ops.
 *
 * Not gated on the flag: if the flag was turned off mid-session, the session
 * that an earlier `activate()` took still has to be handed back.
 *
 * Resolves regardless of outcome.
 */
export async function deactivateVoiceAudioSession(): Promise<void> {
  if (!onNativeShell()) return;
  try {
    await VoiceAudioSession.deactivate();
  } catch (err) {
    console.error("[voice-audio-session] deactivate failed:", err);
  }
}

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
 * cancellation against our own TTS. The `echoCancellation: true` constraint in
 * `utils/voice-input-device.ts` is not sufficient on its own inside a
 * WKWebView: the canceller WebKit gets is chosen by the app's audio session.
 *
 * Gated on the `ios-voice-audio-session` client flag, default off. The gate is
 * in JS rather than Swift so it can be flipped at runtime on an installed
 * build — which is what makes the configuration testable per-device, and
 * switchable off without waiting on a deploy.
 *
 * To enable on one device: Settings, seven taps on the version string, then
 * the Feature Flags panel. That writes the local override through the store,
 * under the camel-cased *store* key — which is the only form
 * `client-feature-flag-store`'s override reader looks for, so a hand-written
 * `localStorage` entry under the kebab-case registry key is ignored. Release
 * builds are not Web Inspector-inspectable, so the panel is the only route on
 * an installed build.
 *
 * Nothing here may throw or reject. `LiveVoiceAudioCapture.start()` is
 * documented never to throw and `use-live-voice.ts` awaits its promise with no
 * catch, so an exception escaping this module takes the whole live-voice
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
 * Whether an `activate()` has been attempted and not yet handed back. Gates
 * `deactivate()` so that a disabled flag means *no* native traffic at all,
 * while a session taken before the flag flipped off is still released.
 *
 * Set on attempt rather than on success: a partially-applied activation (the
 * category took, activation failed) still leaves state the native side must
 * restore.
 */
let sessionHeld = false;

/**
 * Whether to touch the audio session at all. Read non-reactively — the callers
 * are capture lifecycle methods, not React render bodies.
 *
 * Does not wait on `hydrated`: capture must not block on an LD fetch, and the
 * registry default plus any local override is the right answer for a cold
 * start. A flag that flips mid-session takes effect on the next session.
 */
function isEnabled(): boolean {
  try {
    if (!isNativePlatform()) return false;
    return useClientFeatureFlagStore.getState()[FLAG_KEY] === true;
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
  sessionHeld = true;
  try {
    await VoiceAudioSession.activate();
  } catch (err) {
    console.error("[voice-audio-session] activate failed:", err);
  }
}

/**
 * Restore the pre-session audio configuration and release the session. A no-op
 * unless this module holds one.
 *
 * Resolves regardless of outcome.
 */
export async function deactivateVoiceAudioSession(): Promise<void> {
  if (!sessionHeld) return;
  sessionHeld = false;
  try {
    await VoiceAudioSession.deactivate();
  } catch (err) {
    console.error("[voice-audio-session] deactivate failed:", err);
  }
}

import { registerPlugin } from "@capacitor/core";

import { isNativePlatform } from "@/runtime/native-auth";

/**
 * JS ↔ native bridge for the `VoiceAudioSession` Capacitor plugin registered by
 * `clients/ios/App/App/MyViewController.swift` +
 * `clients/ios/App/App/VoiceAudioSessionPlugin.swift`.
 *
 * Puts the iOS app's `AVAudioSession` into `.playAndRecord` / `.voiceChat` for
 * the duration of a live-voice session so the platform runs acoustic echo
 * cancellation against our own TTS, then restores the previous configuration.
 * Without it the assistant hears itself through the speaker and barges in on
 * its own audio (JARVIS-1364) — the `echoCancellation: true` constraint in
 * `utils/voice-input-device.ts` is not enough on its own inside a WKWebView,
 * because the canceller WebKit gets is chosen by the app's audio session.
 *
 * No-op off the Capacitor shell: browsers and Electron have no equivalent
 * app-level audio session, and their `getUserMedia` AEC is already in effect.
 *
 * Failures are swallowed. A session that could not be configured still
 * captures audio — it just echoes, which is strictly better than refusing to
 * start the call.
 */

interface VoiceAudioSessionPlugin {
  activate(): Promise<void>;
  deactivate(): Promise<void>;
}

const VoiceAudioSession =
  registerPlugin<VoiceAudioSessionPlugin>("VoiceAudioSession");

/**
 * Configure and activate the voice-chat audio session. Idempotent — the caller
 * deliberately calls this again after `getUserMedia` resolves, because WebKit
 * reconfigures the shared session when it starts capturing.
 */
export async function activateVoiceAudioSession(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    await VoiceAudioSession.activate();
  } catch (err) {
    console.error("[voice-audio-session] activate failed:", err);
  }
}

/**
 * Restore the pre-session audio configuration and release the session. Safe to
 * call without a matching `activate()` — the native side no-ops.
 */
export async function deactivateVoiceAudioSession(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    await VoiceAudioSession.deactivate();
  } catch (err) {
    console.error("[voice-audio-session] deactivate failed:", err);
  }
}

import { getLocalSetting } from "@/utils/local-settings";

/**
 * Microphone chosen on the Voice settings page, stored as a
 * `MediaDeviceInfo.deviceId`. Empty/absent means "follow the system default".
 */
export const LS_VOICE_INPUT_DEVICE = "vellum:voice:inputDeviceId";

export function getPreferredInputDeviceId(): string {
  return getLocalSetting(LS_VOICE_INPUT_DEVICE, "");
}

/**
 * Audio constraints for voice capture, honoring the microphone chosen on the
 * Voice settings page. Uses `exact` so Chromium 130+ actually selects the
 * device (ideal constraints are silently ignored since that version).
 * Always requests echo cancellation, noise suppression, and auto gain so the
 * mic stays usable while TTS is playing (full-duplex capture).
 */
export function voiceInputAudioConstraints(): MediaTrackConstraints {
  const deviceId = getPreferredInputDeviceId();
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

/**
 * Opens a mic stream honoring the user's device preference. Falls back to the
 * system default if the saved device is unavailable (unplugged, revoked, etc.)
 * rather than failing with an `OverconstrainedError`.
 */
export async function getVoiceInputMediaStream(): Promise<MediaStream> {
  const constraints = voiceInputAudioConstraints();
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: constraints });
  } catch (err) {
    if (
      constraints.deviceId &&
      err instanceof DOMException &&
      err.name === "OverconstrainedError"
    ) {
      const { deviceId: _unpinned, ...fallback } = constraints;
      return navigator.mediaDevices.getUserMedia({ audio: fallback });
    }
    throw err;
  }
}

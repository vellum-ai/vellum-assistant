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
 */
export function voiceInputAudioConstraints(): MediaTrackConstraints | true {
  const deviceId = getPreferredInputDeviceId();
  return deviceId ? { deviceId: { exact: deviceId } } : true;
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
      constraints !== true &&
      err instanceof DOMException &&
      err.name === "OverconstrainedError"
    ) {
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    throw err;
  }
}

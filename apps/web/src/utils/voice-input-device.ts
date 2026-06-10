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
 * Voice settings page. The `deviceId` is a preference rather than `exact` so
 * capture falls back to the system default when the saved device is
 * unplugged instead of failing with an `OverconstrainedError`.
 */
export function voiceInputAudioConstraints(): MediaTrackConstraints | true {
  const deviceId = getPreferredInputDeviceId();
  return deviceId ? { deviceId } : true;
}

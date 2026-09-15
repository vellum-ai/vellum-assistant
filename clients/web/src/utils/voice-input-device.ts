import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
  watchSetting,
} from "@/utils/local-settings";

/**
 * Microphone chosen on the Voice settings page or the companion's popover,
 * stored as a `MediaDeviceInfo.deviceId`. Empty/absent means "follow the
 * system default".
 */
export const LS_VOICE_INPUT_DEVICE = "vellum:voice:inputDeviceId";

export function getPreferredInputDeviceId(): string {
  return getLocalSetting(LS_VOICE_INPUT_DEVICE, "");
}

/** Save the microphone to capture from. Empty follows the system default. */
export function setPreferredInputDeviceId(deviceId: string): void {
  if (deviceId === "") {
    removeLocalSetting(LS_VOICE_INPUT_DEVICE);
  } else {
    setLocalSetting(LS_VOICE_INPUT_DEVICE, deviceId);
  }
}

/** Call `callback` whenever the saved microphone changes, in any window. */
export function watchPreferredInputDevice(callback: () => void): () => void {
  return watchSetting(LS_VOICE_INPUT_DEVICE, callback);
}

/** The microphones a user can pick, as the browser currently reports them. */
export interface VoiceInputDeviceList {
  /** Selectable inputs, without the browser's pseudo-devices. */
  devices: MediaDeviceInfo[];
  /**
   * Inputs exist but none can be told apart, because mic permission has not
   * been granted and the browser redacts ids and labels until it is.
   */
  needsPermission: boolean;
  /**
   * Whether an absent device can be read as unplugged. False while
   * permission is withheld, since the redacted list says nothing about it.
   */
  known: boolean;
}

/**
 * List the microphones a user can pick. Never throws: an environment without
 * enumeration, or one that fails it, lists nothing and knows nothing.
 */
export async function listVoiceInputDevices(): Promise<VoiceInputDeviceList> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return { devices: [], needsPermission: false, known: false };
  }
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const inputs = all.filter((device) => device.kind === "audioinput");
    return {
      // Chromium lists "default"/"communications" pseudo-devices that mirror
      // a physical device already in the list; a System Default option
      // covers that case without the duplicate rows.
      devices: inputs.filter(
        (device) =>
          device.deviceId !== "" &&
          device.deviceId !== "default" &&
          device.deviceId !== "communications",
      ),
      needsPermission:
        inputs.length > 0 && inputs.every((device) => !device.label),
      known: inputs.length === 0 || inputs.some((device) => !!device.label),
    };
  } catch {
    return { devices: [], needsPermission: false, known: false };
  }
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

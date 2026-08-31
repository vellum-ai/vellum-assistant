import { getLocalSetting } from "@/utils/local-settings";

/**
 * Microphone chosen on the Voice settings page, stored as a
 * `MediaDeviceInfo.deviceId`. Empty/absent means "follow the system default".
 */
export const LS_VOICE_INPUT_DEVICE = "vellum:voice:inputDeviceId";

/** Per-call overrides for the shared voice capture constraints. */
export interface VoiceInputConstraintOptions {
  /**
   * Request automatic gain control. Defaults to `true`, which is right for
   * every half-duplex consumer (dictation, the amplitude meter, watch): the
   * mic is the only sound in the room and normalizing a quiet talker up to a
   * usable level makes the transcriber's job easier.
   *
   * Full-duplex live voice passes `false`. Its barge-in gate compares mean
   * absolute amplitude against a threshold on the absolute 16-bit scale
   * (`assistant/src/stt/speech-energy.ts`), and AGC is a moving gain between
   * the room and that fixed number: in a quiet room it lifts the noise floor
   * toward the same absolute level that speech reaches in a loud one, so the
   * gate's real sensitivity becomes a property of the room rather than of the
   * sound. See JARVIS-1694.
   */
  autoGainControl?: boolean;
}

export function getPreferredInputDeviceId(): string {
  return getLocalSetting(LS_VOICE_INPUT_DEVICE, "");
}

/**
 * Audio constraints for voice capture, honoring the microphone chosen on the
 * Voice settings page. Uses `exact` so Chromium 130+ actually selects the
 * device (ideal constraints are silently ignored since that version).
 * Always requests echo cancellation and noise suppression so the mic stays
 * usable while TTS is playing (full-duplex capture); auto gain is on by
 * default and opt-out per {@link VoiceInputConstraintOptions.autoGainControl}.
 */
export function voiceInputAudioConstraints(
  options: VoiceInputConstraintOptions = {},
): MediaTrackConstraints {
  const deviceId = getPreferredInputDeviceId();
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: options.autoGainControl ?? true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

/**
 * Opens a mic stream honoring the user's device preference. Falls back to the
 * system default if the saved device is unavailable (unplugged, revoked, etc.)
 * rather than failing with an `OverconstrainedError`.
 */
export async function getVoiceInputMediaStream(
  options: VoiceInputConstraintOptions = {},
): Promise<MediaStream> {
  const constraints = voiceInputAudioConstraints(options);
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

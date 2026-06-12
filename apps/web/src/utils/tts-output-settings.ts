/**
 * User preferences for TTS (voice mode) audio output: volume and mute.
 *
 * Persisted through the shared localStorage settings helpers so the Voice
 * settings page and the live-voice playback path read the same values, and
 * changes apply live to an in-flight session via {@link watchTtsOutputSettings}.
 */

import {
  getLocalBool,
  getLocalNumber,
  setLocalBool,
  setLocalNumber,
  watchSetting,
} from "@/utils/local-settings";

export const LS_TTS_VOLUME = "vellum:voice:ttsVolume";
export const LS_TTS_MUTED = "vellum:voice:ttsMuted";

export const DEFAULT_TTS_VOLUME = 1;

/** Stored TTS volume in [0, 1]; out-of-range persisted values are clamped. */
export function getTtsVolume(): number {
  const raw = getLocalNumber(LS_TTS_VOLUME, DEFAULT_TTS_VOLUME);
  return Math.min(1, Math.max(0, raw));
}

export function setTtsVolume(volume: number): void {
  setLocalNumber(LS_TTS_VOLUME, Math.min(1, Math.max(0, volume)));
}

export function getTtsMuted(): boolean {
  return getLocalBool(LS_TTS_MUTED, false);
}

export function setTtsMuted(muted: boolean): void {
  setLocalBool(LS_TTS_MUTED, muted);
}

/**
 * Invoke `callback` whenever either TTS output preference changes (same-tab
 * or cross-tab). Returns an unsubscribe function.
 */
export function watchTtsOutputSettings(callback: () => void): () => void {
  const unwatchVolume = watchSetting(LS_TTS_VOLUME, callback);
  const unwatchMuted = watchSetting(LS_TTS_MUTED, callback);
  return () => {
    unwatchVolume();
    unwatchMuted();
  };
}

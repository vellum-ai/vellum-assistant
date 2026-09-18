/**
 * The tone a live voice conversation plays once it is connected and the mic is
 * open, the cue that it is time to talk, and its inverse when the conversation
 * ends.
 *
 * The shipped tone is {@link DEFAULT_VOICE_START_TONE}. The Debug tone lab can
 * store a device-local override so a mix can be auditioned in a real call
 * before it is promoted to a preset in `tone-presets.ts`.
 */

import { TONE_PRESETS } from "@/lib/sounds/tone-presets";
import {
  invertTone,
  playTone,
  sanitizeToneRecipe,
  type ToneRecipe,
} from "@/lib/sounds/tone-synth";

export const DEFAULT_VOICE_START_TONE: ToneRecipe = TONE_PRESETS.bloom;

export const VOICE_START_TONE_OVERRIDE_KEY = "device:voiceStartToneOverride";

/** The lab's stored override, or `null` when none is set or it is unreadable. */
export function readVoiceStartToneOverride(): ToneRecipe | null {
  try {
    const raw = localStorage.getItem(VOICE_START_TONE_OVERRIDE_KEY);
    if (!raw) {
      return null;
    }
    return sanitizeToneRecipe(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Store `recipe` as this device's voice start tone; `null` clears it. */
export function writeVoiceStartToneOverride(recipe: ToneRecipe | null): void {
  try {
    if (recipe) {
      localStorage.setItem(
        VOICE_START_TONE_OVERRIDE_KEY,
        JSON.stringify(recipe),
      );
    } else {
      localStorage.removeItem(VOICE_START_TONE_OVERRIDE_KEY);
    }
  } catch {
    // Storage can be unavailable (private mode, quota); the default still plays.
  }
}

export function resolveVoiceStartTone(): ToneRecipe {
  return readVoiceStartToneOverride() ?? DEFAULT_VOICE_START_TONE;
}

/** The start tone with its pitch sequence reversed; see {@link invertTone}. */
export function playVoiceEndTone(): void {
  void playTone(invertTone(resolveVoiceStartTone()));
}

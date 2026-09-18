import { afterEach, describe, expect, test } from "bun:test";

import { TONE_PRESETS } from "@/lib/sounds/tone-presets";
import {
  DEFAULT_VOICE_START_TONE,
  readVoiceStartToneOverride,
  resolveVoiceStartTone,
  VOICE_START_TONE_OVERRIDE_KEY,
  writeVoiceStartToneOverride,
} from "@/lib/sounds/voice-start-tone";

afterEach(() => {
  localStorage.removeItem(VOICE_START_TONE_OVERRIDE_KEY);
});

describe("voice start tone", () => {
  test("plays the default with no override", () => {
    expect(resolveVoiceStartTone()).toEqual(DEFAULT_VOICE_START_TONE);
  });

  test("plays a stored override, and falls back once it is cleared", () => {
    writeVoiceStartToneOverride(TONE_PRESETS.glass);
    expect(resolveVoiceStartTone()).toEqual(TONE_PRESETS.glass);
    writeVoiceStartToneOverride(null);
    expect(readVoiceStartToneOverride()).toBeNull();
    expect(resolveVoiceStartTone()).toEqual(DEFAULT_VOICE_START_TONE);
  });

  test("ignores an unreadable override", () => {
    localStorage.setItem(VOICE_START_TONE_OVERRIDE_KEY, "{not json");
    expect(resolveVoiceStartTone()).toEqual(DEFAULT_VOICE_START_TONE);
    localStorage.setItem(VOICE_START_TONE_OVERRIDE_KEY, '{"layers":[]}');
    expect(resolveVoiceStartTone()).toEqual(DEFAULT_VOICE_START_TONE);
  });
});

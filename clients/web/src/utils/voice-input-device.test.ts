import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  LS_VOICE_INPUT_DEVICE,
  voiceInputAudioConstraints,
} from "./voice-input-device";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("voiceInputAudioConstraints", () => {
  test("requests processing constraints when no device is pinned", () => {
    expect(voiceInputAudioConstraints()).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
  });

  test("preserves the pinned device alongside processing constraints", () => {
    localStorage.setItem(LS_VOICE_INPUT_DEVICE, "mic-42");
    expect(voiceInputAudioConstraints()).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      deviceId: { exact: "mic-42" },
    });
  });
});

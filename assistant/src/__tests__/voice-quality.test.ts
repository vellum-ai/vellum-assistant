import { describe, expect, mock, test } from "bun:test";

let mockConfig: Record<string, unknown> = {};

mock.module("../config/loader.js", () => ({
  loadConfig: () => mockConfig,
}));

import {
  buildElevenLabsVoiceSpec,
  resolveVoiceQualityProfile,
} from "../calls/voice-quality.js";
import { DEFAULT_ELEVENLABS_VOICE_ID } from "../config/schemas/elevenlabs.js";

describe("buildElevenLabsVoiceSpec", () => {
  test("returns bare voiceId when no model is set", () => {
    expect(buildElevenLabsVoiceSpec({ voiceId: "abc123" })).toBe("abc123");
  });

  test("returns empty string when voiceId is empty", () => {
    expect(buildElevenLabsVoiceSpec({ voiceId: "" })).toBe("");
  });

  test("returns empty string when voiceId is whitespace", () => {
    expect(buildElevenLabsVoiceSpec({ voiceId: "  " })).toBe("");
  });

  test("returns bare voiceId when voiceModelId is empty", () => {
    expect(
      buildElevenLabsVoiceSpec({ voiceId: "abc123", voiceModelId: "" }),
    ).toBe("abc123");
  });

  test("returns bare voiceId when voiceModelId is whitespace", () => {
    expect(
      buildElevenLabsVoiceSpec({ voiceId: "abc123", voiceModelId: "  " }),
    ).toBe("abc123");
  });

  test("appends model and defaults when voiceModelId is provided", () => {
    const result = buildElevenLabsVoiceSpec({
      voiceId: "abc123",
      voiceModelId: "eleven_turbo_v2",
    });
    expect(result).toBe("abc123-eleven_turbo_v2-1_0.5_0.75");
  });

  test("uses custom speed, stability, and similarity values", () => {
    const result = buildElevenLabsVoiceSpec({
      voiceId: "voice1",
      voiceModelId: "model1",
      speed: 1.5,
      stability: 0.8,
      similarityBoost: 0.9,
    });
    expect(result).toBe("voice1-model1-1.5_0.8_0.9");
  });

  test("trims whitespace from voiceId", () => {
    expect(buildElevenLabsVoiceSpec({ voiceId: "  abc123  " })).toBe("abc123");
  });
});

describe("resolveVoiceQualityProfile", () => {
  test("always returns ElevenLabs ttsProvider", () => {
    mockConfig = {
      elevenlabs: { voiceId: DEFAULT_ELEVENLABS_VOICE_ID },
      calls: {
        voice: {
          language: "en-US",
          transcriptionProvider: "Deepgram",
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.ttsProvider).toBe("ElevenLabs");
  });

  test("voice ID comes from elevenlabs.voiceId", () => {
    mockConfig = {
      elevenlabs: { voiceId: "custom-voice-123" },
      calls: {
        voice: {
          language: "en-US",
          transcriptionProvider: "Deepgram",
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.voice).toBe("custom-voice-123");
  });

  test("uses language from calls.voice config", () => {
    mockConfig = {
      elevenlabs: { voiceId: "abc" },
      calls: {
        voice: {
          language: "es-MX",
          transcriptionProvider: "Google",
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.language).toBe("es-MX");
    expect(profile.transcriptionProvider).toBe("Google");
  });

  test("builds voice spec with model and tuning params", () => {
    mockConfig = {
      elevenlabs: {
        voiceId: "voice1",
        voiceModelId: "turbo_v2_5",
        speed: 0.9,
        stability: 0.8,
        similarityBoost: 0.9,
      },
      calls: {
        voice: {
          language: "en-US",
          transcriptionProvider: "Deepgram",
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.voice).toBe("voice1-turbo_v2_5-0.9_0.8_0.9");
  });

  test("profanityFilter is always false", () => {
    mockConfig = {
      elevenlabs: { voiceId: "abc" },
      calls: {
        voice: {
          language: "en-US",
          transcriptionProvider: "Deepgram",
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.profanityFilter).toBe(false);
  });

  test("interruptSensitivity defaults to 'low' when not configured", () => {
    mockConfig = {
      elevenlabs: { voiceId: "abc" },
      calls: {
        voice: {
          language: "en-US",
          transcriptionProvider: "Deepgram",
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.interruptSensitivity).toBe("low");
  });

  test("interruptSensitivity reflects configured value", () => {
    mockConfig = {
      elevenlabs: { voiceId: "abc" },
      calls: {
        voice: {
          language: "en-US",
          transcriptionProvider: "Deepgram",
          interruptSensitivity: "high",
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.interruptSensitivity).toBe("high");
  });

  test("hints defaults to empty array when not configured", () => {
    mockConfig = {
      elevenlabs: { voiceId: "abc" },
      calls: {
        voice: {
          language: "en-US",
          transcriptionProvider: "Deepgram",
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.hints).toEqual([]);
  });

  test("hints reflects configured values", () => {
    mockConfig = {
      elevenlabs: { voiceId: "abc" },
      calls: {
        voice: {
          language: "en-US",
          transcriptionProvider: "Deepgram",
          hints: ["Vellum", "Velissa", "AI assistant"],
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.hints).toEqual(["Vellum", "Velissa", "AI assistant"]);
  });
});

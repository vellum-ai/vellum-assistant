import { describe, expect, mock, test } from "bun:test";

let mockConfig: Record<string, unknown> = {};

mock.module("../config/loader.js", () => ({
  loadConfig: () => mockConfig,
}));

import { resolveTelephonySttProfile } from "../calls/stt-profile.js";
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

// ── resolveTelephonySttProfile (adapter unit tests) ─────────────────

describe("resolveTelephonySttProfile", () => {
  test("Deepgram defaults speechModel to nova-3 when unset", () => {
    const profile = resolveTelephonySttProfile({
      transcriptionProvider: "Deepgram",
      speechModel: undefined,
    });
    expect(profile.provider).toBe("Deepgram");
    expect(profile.speechModel).toBe("nova-3");
  });

  test("Deepgram preserves explicitly set speechModel", () => {
    const profile = resolveTelephonySttProfile({
      transcriptionProvider: "Deepgram",
      speechModel: "nova-2-phonecall",
    });
    expect(profile.provider).toBe("Deepgram");
    expect(profile.speechModel).toBe("nova-2-phonecall");
  });

  test("Google leaves speechModel undefined when unset", () => {
    const profile = resolveTelephonySttProfile({
      transcriptionProvider: "Google",
      speechModel: undefined,
    });
    expect(profile.provider).toBe("Google");
    expect(profile.speechModel).toBeUndefined();
  });

  test("Google treats legacy Deepgram default nova-3 as unset", () => {
    const profile = resolveTelephonySttProfile({
      transcriptionProvider: "Google",
      speechModel: "nova-3",
    });
    expect(profile.provider).toBe("Google");
    expect(profile.speechModel).toBeUndefined();
  });

  test("Google preserves explicitly set non-legacy speechModel", () => {
    const profile = resolveTelephonySttProfile({
      transcriptionProvider: "Google",
      speechModel: "telephony",
    });
    expect(profile.provider).toBe("Google");
    expect(profile.speechModel).toBe("telephony");
  });
});

// ── resolveVoiceQualityProfile ──────────────────────────────────────

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
          hints: ["Vellum", "Nova", "AI assistant"],
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.hints).toEqual(["Vellum", "Nova", "AI assistant"]);
  });

  test("delegates STT resolution to adapter — Deepgram defaults to nova-3", () => {
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
    expect(profile.transcriptionProvider).toBe("Deepgram");
    expect(profile.speechModel).toBe("nova-3");
  });

  test("delegates STT resolution to adapter — Google leaves speechModel undefined", () => {
    mockConfig = {
      elevenlabs: { voiceId: "abc" },
      calls: {
        voice: {
          language: "en-US",
          transcriptionProvider: "Google",
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.transcriptionProvider).toBe("Google");
    expect(profile.speechModel).toBeUndefined();
  });

  test("delegates STT resolution to adapter — Google strips legacy nova-3", () => {
    mockConfig = {
      elevenlabs: { voiceId: "abc" },
      calls: {
        voice: {
          language: "en-US",
          transcriptionProvider: "Google",
          speechModel: "nova-3",
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.transcriptionProvider).toBe("Google");
    expect(profile.speechModel).toBeUndefined();
  });

  test("delegates STT resolution to adapter — Google preserves explicit model", () => {
    mockConfig = {
      elevenlabs: { voiceId: "abc" },
      calls: {
        voice: {
          language: "en-US",
          transcriptionProvider: "Google",
          speechModel: "telephony",
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.transcriptionProvider).toBe("Google");
    expect(profile.speechModel).toBe("telephony");
  });
});

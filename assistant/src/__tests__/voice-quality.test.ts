import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Logger mock ──────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── Credential mock (prevents real key lookups) ──────────────────────

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => null,
  getSecureKey: () => null,
}));

mock.module("../security/credential-key.js", () => ({
  credentialKey: (...args: string[]) => args.join("/"),
}));

// ── Config mock ──────────────────────────────────────────────────────

let mockConfig: Record<string, unknown> = {};

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
}));

// ── TTS registry setup ───────────────────────────────────────────────

import {
  _resetTtsProviderRegistry,
  registerTtsProvider,
} from "../tts/provider-registry.js";
import type { TtsProvider } from "../tts/types.js";

function registerTestProviders(): void {
  _resetTtsProviderRegistry();

  // ElevenLabs: native provider (no streaming)
  const elevenlabs: TtsProvider = {
    id: "elevenlabs",
    capabilities: { supportsStreaming: false, supportedFormats: ["mp3"] },
    async synthesize() {
      return { audio: Buffer.from(""), contentType: "audio/mpeg" };
    },
  };
  registerTtsProvider(elevenlabs);

  // Fish Audio: synthesized provider (streaming)
  const fishAudio: TtsProvider = {
    id: "fish-audio",
    capabilities: {
      supportsStreaming: true,
      supportedFormats: ["mp3", "wav", "opus"],
    },
    async synthesize() {
      return { audio: Buffer.from(""), contentType: "audio/mpeg" };
    },
    async synthesizeStream(_req, _onChunk) {
      return { audio: Buffer.from(""), contentType: "audio/mpeg" };
    },
  };
  registerTtsProvider(fishAudio);
}

// ── Import subjects after mocks ──────────────────────────────────────

import {
  buildElevenLabsVoiceSpec,
  resolveVoiceQualityProfile,
} from "../calls/voice-quality.js";
import { DEFAULT_ELEVENLABS_VOICE_ID } from "../config/schemas/elevenlabs.js";

// ── Tests ────────────────────────────────────────────────────────────

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
  beforeEach(() => {
    registerTestProviders();
  });

  // ── Native provider path (ElevenLabs) ─────────────────────────────

  test("returns ElevenLabs ttsProvider for native provider", () => {
    mockConfig = {
      elevenlabs: { voiceId: DEFAULT_ELEVENLABS_VOICE_ID },
      calls: {
        voice: {
          language: "en-US",
          transcriptionProvider: "Deepgram",
        },
      },
      services: {
        tts: {
          provider: "elevenlabs",
          providers: {
            elevenlabs: { voiceId: DEFAULT_ELEVENLABS_VOICE_ID },
            "fish-audio": { referenceId: "" },
          },
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.ttsProvider).toBe("ElevenLabs");
  });

  test("voice ID comes from elevenlabs.voiceId for native provider", () => {
    mockConfig = {
      elevenlabs: { voiceId: "custom-voice-123" },
      calls: {
        voice: {
          language: "en-US",
          transcriptionProvider: "Deepgram",
        },
      },
      services: {
        tts: {
          provider: "elevenlabs",
          providers: {
            elevenlabs: { voiceId: "custom-voice-123" },
            "fish-audio": { referenceId: "" },
          },
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
      services: {
        tts: {
          provider: "elevenlabs",
          providers: {
            elevenlabs: { voiceId: "abc" },
            "fish-audio": { referenceId: "" },
          },
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
      services: {
        tts: {
          provider: "elevenlabs",
          providers: {
            elevenlabs: { voiceId: "voice1" },
            "fish-audio": { referenceId: "" },
          },
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
      services: {
        tts: {
          provider: "elevenlabs",
          providers: {
            elevenlabs: { voiceId: "abc" },
            "fish-audio": { referenceId: "" },
          },
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
      services: {
        tts: {
          provider: "elevenlabs",
          providers: {
            elevenlabs: { voiceId: "abc" },
            "fish-audio": { referenceId: "" },
          },
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
      services: {
        tts: {
          provider: "elevenlabs",
          providers: {
            elevenlabs: { voiceId: "abc" },
            "fish-audio": { referenceId: "" },
          },
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
      services: {
        tts: {
          provider: "elevenlabs",
          providers: {
            elevenlabs: { voiceId: "abc" },
            "fish-audio": { referenceId: "" },
          },
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.hints).toEqual(["Vellum", "Nova", "AI assistant"]);
  });

  // ── Synthesized provider path (Fish Audio) ────────────────────────

  test("returns Google placeholder ttsProvider for synthesized provider (Fish Audio)", () => {
    mockConfig = {
      elevenlabs: { voiceId: DEFAULT_ELEVENLABS_VOICE_ID },
      fishAudio: { referenceId: "ref-123" },
      calls: {
        voice: {
          language: "en-US",
          transcriptionProvider: "Deepgram",
          ttsProvider: "fish-audio",
        },
      },
      services: {
        tts: {
          provider: "fish-audio",
          providers: {
            elevenlabs: { voiceId: DEFAULT_ELEVENLABS_VOICE_ID },
            "fish-audio": { referenceId: "ref-123" },
          },
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.ttsProvider).toBe("Google");
    expect(profile.voice).toBe("");
  });

  test("preserves transcription and language settings for synthesized providers", () => {
    mockConfig = {
      elevenlabs: { voiceId: DEFAULT_ELEVENLABS_VOICE_ID },
      fishAudio: { referenceId: "ref-123" },
      calls: {
        voice: {
          language: "ja-JP",
          transcriptionProvider: "Google",
          ttsProvider: "fish-audio",
          speechModel: "nova-3",
        },
      },
      services: {
        tts: {
          provider: "fish-audio",
          providers: {
            elevenlabs: { voiceId: DEFAULT_ELEVENLABS_VOICE_ID },
            "fish-audio": { referenceId: "ref-123" },
          },
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.language).toBe("ja-JP");
    expect(profile.transcriptionProvider).toBe("Google");
    // speechModel "nova-3" is treated as unset for Google transcription
    expect(profile.speechModel).toBeUndefined();
  });

  // ── Legacy fallback (calls.voice.ttsProvider disagrees with services.tts.provider) ──

  test("falls back to legacy calls.voice.ttsProvider when services.tts.provider is still default", () => {
    mockConfig = {
      elevenlabs: { voiceId: DEFAULT_ELEVENLABS_VOICE_ID },
      fishAudio: { referenceId: "ref-abc" },
      calls: {
        voice: {
          language: "en-US",
          transcriptionProvider: "Deepgram",
          ttsProvider: "fish-audio", // legacy key set to fish-audio
        },
      },
      services: {
        tts: {
          provider: "elevenlabs", // canonical still at default
          providers: {
            elevenlabs: { voiceId: DEFAULT_ELEVENLABS_VOICE_ID },
            "fish-audio": { referenceId: "ref-abc" },
          },
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    // Should resolve to fish-audio (legacy override)
    expect(profile.ttsProvider).toBe("Google");
    expect(profile.voice).toBe("");
  });
});

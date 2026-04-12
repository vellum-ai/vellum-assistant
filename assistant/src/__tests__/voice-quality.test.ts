import { beforeEach, describe, expect, mock, test } from "bun:test";

// -- Logger mock ----------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// -- Credential mock (prevents real key lookups) --------------------------

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => null,
  getSecureKey: () => null,
}));

mock.module("../security/credential-key.js", () => ({
  credentialKey: (...args: string[]) => args.join("/"),
}));

// -- Config mock ----------------------------------------------------------

let mockConfig: Record<string, unknown> = {};

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
}));

// -- Call strategy voice-spec registry setup --------------------------------

import {
  _resetNativeTwilioVoiceSpecRegistry,
  registerNativeTwilioVoiceSpec,
} from "../calls/tts-call-strategy.js";
import {
  _resetTtsProviderRegistry,
  registerTtsProvider,
} from "../tts/provider-registry.js";
import type { TtsProvider } from "../tts/types.js";

function registerTestVoiceSpecs(): void {
  _resetNativeTwilioVoiceSpecRegistry();
  _resetTtsProviderRegistry();

  // Register runtime TTS providers (needed for availability checks).
  const elevenlabs: TtsProvider = {
    id: "elevenlabs",
    capabilities: { supportsStreaming: false, supportedFormats: ["mp3"] },
    async synthesize() {
      return { audio: Buffer.from(""), contentType: "audio/mpeg" };
    },
  };
  registerTtsProvider(elevenlabs);

  const fishAudio: TtsProvider = {
    id: "fish-audio",
    capabilities: {
      supportsStreaming: true,
      supportedFormats: ["mp3", "wav", "opus"],
    },
    async synthesize() {
      return { audio: Buffer.from(""), contentType: "audio/mpeg" };
    },
    async synthesizeStream() {
      return { audio: Buffer.from(""), contentType: "audio/mpeg" };
    },
  };
  registerTtsProvider(fishAudio);

  // Register the ElevenLabs native Twilio voice-spec builder (mirrors
  // the production registration in register-builtins.ts).
  registerNativeTwilioVoiceSpec("elevenlabs", {
    twilioProviderName: "ElevenLabs",
    buildVoiceSpec: (providerConfig) => {
      const cfg = providerConfig as {
        voiceId?: string;
        voiceModelId?: string;
        speed?: number;
        stability?: number;
        similarityBoost?: number;
      };
      return buildElevenLabsVoiceSpec({
        voiceId: cfg.voiceId ?? "",
        voiceModelId: cfg.voiceModelId,
        speed: cfg.speed,
        stability: cfg.stability,
        similarityBoost: cfg.similarityBoost,
      });
    },
  });
}

// -- Import subjects after mocks ------------------------------------------

import {
  buildElevenLabsVoiceSpec,
  resolveVoiceQualityProfile,
} from "../calls/voice-quality.js";
import { DEFAULT_ELEVENLABS_VOICE_ID } from "../config/schemas/elevenlabs.js";

// -- Tests ----------------------------------------------------------------

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

// ── resolveVoiceQualityProfile ──────────────────────────────────────

describe("resolveVoiceQualityProfile", () => {
  beforeEach(() => {
    registerTestVoiceSpecs();
  });

  // -- Explicit strategy: native-twilio (ElevenLabs) ----------------------

  test("uses catalog callMode to select native-twilio path for ElevenLabs", () => {
    mockConfig = {
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

  test("voice spec comes from registered NativeTwilioVoiceSpec builder", () => {
    mockConfig = {
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
  });

  test("builds voice spec with model and tuning params via builder", () => {
    mockConfig = {
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
            elevenlabs: {
              voiceId: "voice1",
              voiceModelId: "turbo_v2_5",
              speed: 0.9,
              stability: 0.8,
              similarityBoost: 0.9,
            },
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

  // -- Explicit strategy: synthesized-play (Fish Audio) -------------------

  test("uses catalog callMode to select synthesized-play path for Fish Audio", () => {
    mockConfig = {
      calls: {
        voice: {
          language: "en-US",
          transcriptionProvider: "Deepgram",
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

  test("preserves language setting for synthesized providers", () => {
    mockConfig = {
      calls: {
        voice: {
          language: "ja-JP",
          transcriptionProvider: "Google",
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
    // STT fields (transcriptionProvider, speechModel) are resolved separately
    // in twilio-routes.ts via resolveTelephonySttProfile() — not on this profile.
  });

  // -- Canonical-only behavior (no legacy fallback) -----------------------

  test("reads provider exclusively from services.tts.provider", () => {
    mockConfig = {
      calls: {
        voice: {
          language: "en-US",
          transcriptionProvider: "Deepgram",
        },
      },
      services: {
        tts: {
          provider: "fish-audio",
          providers: {
            elevenlabs: { voiceId: DEFAULT_ELEVENLABS_VOICE_ID },
            "fish-audio": { referenceId: "ref-abc" },
          },
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    // Should resolve to fish-audio from canonical config
    expect(profile.ttsProvider).toBe("Google");
    expect(profile.voice).toBe("");
  });

  // -- Strategy-based behavior (explicit call strategy) -------------------

  test("strategy selects path from catalog callMode, not supportsStreaming", () => {
    // The catalog declares fish-audio as synthesized-play via callMode,
    // regardless of its supportsStreaming capability. This test verifies
    // call-path selection is driven by explicit catalog metadata.
    mockConfig = {
      calls: {
        voice: {
          language: "en-US",
          transcriptionProvider: "Deepgram",
        },
      },
      services: {
        tts: {
          provider: "fish-audio",
          providers: {
            elevenlabs: { voiceId: DEFAULT_ELEVENLABS_VOICE_ID },
            "fish-audio": { referenceId: "ref-abc" },
          },
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.ttsProvider).toBe("Google");
    expect(profile.voice).toBe("");
  });

  test("native-twilio strategy delegates voice-spec to registered builder", () => {
    // The catalog declares elevenlabs as native-twilio. The voice spec
    // is built by the registered NativeTwilioVoiceSpec builder, not by
    // hardcoded branching in resolveVoiceQualityProfile.
    mockConfig = {
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
            elevenlabs: {
              voiceId: "test-voice",
              voiceModelId: "model-x",
              speed: 1.1,
              stability: 0.6,
              similarityBoost: 0.8,
            },
            "fish-audio": { referenceId: "" },
          },
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.ttsProvider).toBe("ElevenLabs");
    expect(profile.voice).toBe("test-voice-model-x-1.1_0.6_0.8");
  });

  test("falls back to ElevenLabs config when voice-spec builder is not registered", () => {
    // Clear the voice-spec registry to simulate missing builder.
    _resetNativeTwilioVoiceSpecRegistry();

    mockConfig = {
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
            elevenlabs: { voiceId: "some-voice" },
            "fish-audio": { referenceId: "" },
          },
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    // Falls back to reading from the elevenlabs config block directly.
    expect(profile.ttsProvider).toBe("ElevenLabs");
    expect(profile.voice).toBe("some-voice");
  });

  test("falls back to default voice ID when no config or builder available", () => {
    // Clear the voice-spec registry and omit elevenlabs config.
    _resetNativeTwilioVoiceSpecRegistry();

    mockConfig = {
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
            "fish-audio": { referenceId: "" },
          },
        },
      },
    };
    const profile = resolveVoiceQualityProfile();
    expect(profile.ttsProvider).toBe("ElevenLabs");
    expect(profile.voice).toBe(DEFAULT_ELEVENLABS_VOICE_ID);
  });
});

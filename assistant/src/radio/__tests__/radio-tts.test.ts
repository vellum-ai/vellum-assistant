import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockSynthesisResult: { audio: Buffer; contentType: string };
let mockSynthesisError: Error | null;
let lastSynthesizeOptions: Record<string, unknown> | null;
let lastStoredAudio: {
  buffer: Buffer;
  format: "mp3" | "wav" | "opus" | "pcm";
} | null;

class MockTtsSynthesisError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TtsSynthesisError";
    this.code = code;
  }
}

mock.module("../../tts/synthesize-text.js", () => ({
  synthesizeText: async (options: Record<string, unknown>) => {
    lastSynthesizeOptions = options;
    if (mockSynthesisError) throw mockSynthesisError;
    return mockSynthesisResult;
  },
  TtsSynthesisError: MockTtsSynthesisError,
}));

mock.module("../../calls/audio-store.js", () => ({
  storeAudio: (buffer: Buffer, format: "mp3" | "wav" | "opus" | "pcm") => {
    lastStoredAudio = { buffer, format };
    return "audio-123";
  },
}));

const {
  RadioTtsEmptyTextError,
  RadioTtsSetupRequiredError,
  audioFormatFromContentType,
  synthesizeRadioDjBreak,
} = await import("../radio-tts.js");

describe("radio TTS", () => {
  beforeEach(() => {
    mockSynthesisResult = {
      audio: Buffer.from("fake-audio"),
      contentType: "audio/wave",
    };
    mockSynthesisError = null;
    lastSynthesizeOptions = null;
    lastStoredAudio = null;
  });

  test("maps content types to audio store formats", () => {
    expect(audioFormatFromContentType("audio/mpeg")).toBe("mp3");
    expect(audioFormatFromContentType("audio/mp3")).toBe("mp3");
    expect(audioFormatFromContentType("audio/wav")).toBe("wav");
    expect(audioFormatFromContentType("audio/wave")).toBe("wav");
    expect(audioFormatFromContentType("audio/opus")).toBe("opus");
    expect(audioFormatFromContentType("audio/pcm")).toBe("pcm");
    expect(audioFormatFromContentType("application/octet-stream")).toBe("mp3");
    expect(audioFormatFromContentType("audio/wav; charset=binary")).toBe("wav");
  });

  test("sanitizes text, synthesizes it, stores audio, and returns an audio path", async () => {
    const signal = new AbortController().signal;

    const result = await synthesizeRadioDjBreak(
      " **Hello**, [world](https://example.com)! ",
      signal,
    );

    expect(lastSynthesizeOptions).toEqual({
      text: "Hello, world!",
      useCase: "message-playback",
      signal,
    });
    expect(lastStoredAudio).toEqual({
      buffer: Buffer.from("fake-audio"),
      format: "wav",
    });
    expect(result).toEqual({
      text: "Hello, world!",
      audioId: "audio-123",
      audioPath: "audio/audio-123",
      contentType: "audio/wave",
    });
  });

  test("maps missing TTS provider to setup-required", async () => {
    mockSynthesisError = new MockTtsSynthesisError(
      "TTS_PROVIDER_NOT_CONFIGURED",
      "TTS provider is not configured",
    );

    try {
      await synthesizeRadioDjBreak("hello");
      throw new Error("Expected setup-required error");
    } catch (error) {
      expect(error).toBeInstanceOf(RadioTtsSetupRequiredError);
      expect(error).toMatchObject({
        name: "RadioTtsSetupRequiredError",
        reason: "tts_not_configured",
        settingsPath: "/assistant/settings/ai",
      });
    }
  });

  test("rejects empty sanitized DJ text with a typed error", async () => {
    await expect(
      synthesizeRadioDjBreak("   **   **   "),
    ).rejects.toBeInstanceOf(RadioTtsEmptyTextError);
    expect(lastSynthesizeOptions).toBeNull();
    expect(lastStoredAudio).toBeNull();
  });
});

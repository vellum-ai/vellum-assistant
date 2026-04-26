import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  _resetTtsProviderRegistry,
  registerTtsProvider,
} from "../../tts/provider-registry.js";
import type {
  TtsProvider,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from "../../tts/types.js";
import type {
  LiveVoiceTtsAudioChunk,
  LiveVoiceTtsConfig,
} from "../live-voice-tts.js";

let config = makeConfig();

const { LiveVoiceTtsError, streamLiveVoiceTtsAudio } =
  await import("../live-voice-tts.js");

beforeEach(() => {
  config = makeConfig();
  _resetTtsProviderRegistry();
});

describe("streamLiveVoiceTtsAudio", () => {
  test("buffers non-PCM Fish Audio chunks into one playable frame", async () => {
    const requests: TtsSynthesisRequest[] = [];
    const provider: TtsProvider = {
      id: "fish-audio",
      capabilities: {
        supportsStreaming: true,
        supportedFormats: ["mp3", "wav", "opus"],
      },
      async synthesize(): Promise<TtsSynthesisResult> {
        throw new Error("buffered synthesis should not be used");
      },
      async synthesizeStream(
        request: TtsSynthesisRequest,
        onChunk: (chunk: Uint8Array) => void,
      ): Promise<TtsSynthesisResult> {
        requests.push(request);
        onChunk(Buffer.from("chunk-one"));
        onChunk(Buffer.from("chunk-two"));
        return {
          audio: Buffer.from("chunk-onechunk-two"),
          contentType: "audio/mpeg",
        };
      },
    };
    registerTtsProvider(provider);

    const frames: LiveVoiceTtsAudioChunk[] = [];
    const result = await streamLiveVoiceTtsAudio({
      config,
      text: "hello from live voice",
      sampleRate: 24_000,
      onAudioChunk: (chunk) => frames.push(chunk),
    });

    expect(requests).toEqual([
      {
        text: "hello from live voice",
        useCase: "phone-call",
        voiceId: undefined,
        signal: undefined,
        outputFormat: undefined,
      },
    ]);
    expect(frames).toEqual([
      {
        type: "tts_audio",
        contentType: "audio/mpeg",
        sampleRate: 24_000,
        dataBase64: Buffer.from("chunk-onechunk-two").toString("base64"),
      },
    ]);
    expect(result).toEqual({
      provider: "fish-audio",
      contentType: "audio/mpeg",
      sampleRate: 24_000,
      chunks: 1,
      bytes: Buffer.byteLength("chunk-onechunk-two"),
    });
  });

  test("emits split Fish Audio WAV chunks as one complete WAV frame", async () => {
    const requests: TtsSynthesisRequest[] = [];
    registerTtsProvider({
      id: "fish-audio",
      capabilities: {
        supportsStreaming: true,
        supportedFormats: ["mp3", "wav", "opus"],
      },
      async synthesize(): Promise<TtsSynthesisResult> {
        throw new Error("buffered synthesis should not be used");
      },
      async synthesizeStream(
        request: TtsSynthesisRequest,
        onChunk: (chunk: Uint8Array) => void,
      ): Promise<TtsSynthesisResult> {
        requests.push(request);
        onChunk(Buffer.from("wav-"));
        onChunk(Buffer.from("chunk"));
        return {
          audio: Buffer.from("wav-chunk"),
          contentType: "audio/wav",
        };
      },
    });

    const frames: LiveVoiceTtsAudioChunk[] = [];
    const result = await streamLiveVoiceTtsAudio({
      config,
      text: "hello from live voice",
      outputFormat: "pcm",
      onAudioChunk: (chunk) => frames.push(chunk),
    });

    expect(requests[0]?.outputFormat).toBe("pcm");
    expect(frames).toEqual([
      {
        type: "tts_audio",
        contentType: "audio/wav",
        sampleRate: 24_000,
        dataBase64: Buffer.from("wav-chunk").toString("base64"),
      },
    ]);
    expect(result).toMatchObject({
      contentType: "audio/wav",
      chunks: 1,
      bytes: Buffer.byteLength("wav-chunk"),
    });
  });

  test("streams raw PCM provider chunks incrementally", async () => {
    config = makeConfig({ provider: "elevenlabs" });
    const requests: TtsSynthesisRequest[] = [];
    registerTtsProvider({
      id: "elevenlabs",
      capabilities: {
        supportsStreaming: true,
        supportedFormats: ["mp3", "pcm"],
      },
      async synthesize(): Promise<TtsSynthesisResult> {
        throw new Error("buffered synthesis should not be used");
      },
      async synthesizeStream(
        request: TtsSynthesisRequest,
        onChunk: (chunk: Uint8Array) => void,
      ): Promise<TtsSynthesisResult> {
        requests.push(request);
        onChunk(Buffer.from("pcm-one"));
        onChunk(Buffer.from("pcm-two"));
        return {
          audio: Buffer.from("pcm-onepcm-two"),
          contentType: "audio/pcm",
        };
      },
    });

    const frames: LiveVoiceTtsAudioChunk[] = [];
    const result = await streamLiveVoiceTtsAudio({
      config,
      text: "hello from live voice",
      outputFormat: "pcm",
      onAudioChunk: (chunk) => frames.push(chunk),
    });

    expect(requests[0]?.outputFormat).toBe("pcm");
    expect(frames).toEqual([
      {
        type: "tts_audio",
        contentType: "audio/pcm",
        sampleRate: 24_000,
        dataBase64: Buffer.from("pcm-one").toString("base64"),
      },
      {
        type: "tts_audio",
        contentType: "audio/pcm",
        sampleRate: 24_000,
        dataBase64: Buffer.from("pcm-two").toString("base64"),
      },
    ]);
    expect(result).toEqual({
      provider: "elevenlabs",
      contentType: "audio/pcm",
      sampleRate: 24_000,
      chunks: 2,
      bytes: Buffer.byteLength("pcm-onepcm-two"),
    });
  });

  test("returns a typed configuration error for a non-streaming provider", async () => {
    config = makeConfig({ provider: "elevenlabs" });
    registerTtsProvider({
      id: "elevenlabs",
      capabilities: { supportsStreaming: false, supportedFormats: ["mp3"] },
      async synthesize(): Promise<TtsSynthesisResult> {
        return { audio: Buffer.from("audio"), contentType: "audio/mpeg" };
      },
    });

    await expect(
      streamLiveVoiceTtsAudio({
        config,
        text: "hello",
        onAudioChunk: () => {},
      }),
    ).rejects.toMatchObject({
      name: "LiveVoiceTtsError",
      code: "LIVE_VOICE_TTS_STREAMING_UNAVAILABLE",
      provider: "elevenlabs",
    });
  });

  test("returns a typed configuration error when provider credentials are missing", async () => {
    registerTtsProvider({
      id: "fish-audio",
      capabilities: {
        supportsStreaming: true,
        supportedFormats: ["mp3", "wav", "opus"],
      },
      async synthesize(): Promise<TtsSynthesisResult> {
        throw new Error("buffered synthesis should not be used");
      },
      async synthesizeStream(): Promise<TtsSynthesisResult> {
        const err = new Error("Fish Audio API key not configured");
        Object.assign(err, { code: "FISH_AUDIO_TTS_NO_API_KEY" });
        throw err;
      },
    });

    await expect(
      streamLiveVoiceTtsAudio({
        config,
        text: "hello",
        onAudioChunk: () => {},
      }),
    ).rejects.toMatchObject({
      name: "LiveVoiceTtsError",
      code: "LIVE_VOICE_TTS_CONFIGURATION_ERROR",
      provider: "fish-audio",
    });
  });

  test("wraps provider streaming failures as synthesis errors", async () => {
    registerTtsProvider({
      id: "fish-audio",
      capabilities: {
        supportsStreaming: true,
        supportedFormats: ["mp3", "wav", "opus"],
      },
      async synthesize(): Promise<TtsSynthesisResult> {
        throw new Error("buffered synthesis should not be used");
      },
      async synthesizeStream(): Promise<TtsSynthesisResult> {
        throw new Error("provider exploded");
      },
    });

    try {
      await streamLiveVoiceTtsAudio({
        config,
        text: "hello",
        onAudioChunk: () => {},
      });
      throw new Error("Expected streamLiveVoiceTtsAudio to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LiveVoiceTtsError);
      expect(err).toMatchObject({
        code: "LIVE_VOICE_TTS_SYNTHESIS_FAILED",
        provider: "fish-audio",
      });
      expect((err as Error).message).toContain("provider exploded");
    }
  });

  test("keeps live voice TTS behind the registry instead of direct provider SDKs", () => {
    const source = readFileSync(
      new URL("../live-voice-tts.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("getTtsProvider");
    expect(source).toContain("resolveTtsConfig");
    expect(source).not.toMatch(/fish-audio-client/);
    expect(source).not.toMatch(/from\s+["']@/);
    expect(source).not.toContain("fetch(");
  });
});

function makeConfig(
  overrides: {
    provider?: string;
    format?: "mp3" | "wav" | "opus";
    sampleRate?: number;
  } = {},
): LiveVoiceTtsConfig {
  return {
    services: {
      tts: {
        provider: overrides.provider ?? "fish-audio",
        providers: {
          "fish-audio": {
            referenceId: "fish-ref-123",
            chunkLength: 200,
            format: overrides.format ?? "mp3",
            latency: "normal",
            speed: 1.0,
          },
          elevenlabs: {
            voiceId: "voice-123",
            voiceModelId: "",
            speed: 1.0,
            stability: 0.5,
            similarityBoost: 0.75,
            conversationTimeoutSeconds: 30,
          },
          deepgram: {
            model: "aura-asteria-en",
            format: "mp3",
          },
          xai: {
            voiceId: "eve",
            language: "auto",
            format: "mp3",
            sampleRate: overrides.sampleRate ?? 24_000,
            bitRate: 128_000,
          },
        },
      },
    },
  } as LiveVoiceTtsConfig;
}

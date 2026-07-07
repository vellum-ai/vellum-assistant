import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  _resetTtsProviderOverridesForTests,
  _setTtsProviderForTests,
} from "../../tts/provider-catalog.js";
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
  _resetTtsProviderOverridesForTests();
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
    _setTtsProviderForTests(provider);

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
        sampleRateHz: 24_000,
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
    _setTtsProviderForTests({
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
    _setTtsProviderForTests({
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
        onChunk(Buffer.from("pcm-one!"));
        onChunk(Buffer.from("pcm-two!"));
        return {
          audio: Buffer.from("pcm-one!pcm-two!"),
          contentType: "audio/pcm",
        };
      },
    });

    const frames: LiveVoiceTtsAudioChunk[] = [];
    const result = await streamLiveVoiceTtsAudio({
      config,
      text: "hello from live voice",
      outputFormat: "pcm",
      sampleRate: 16_000,
      onAudioChunk: (chunk) => frames.push(chunk),
    });

    expect(requests[0]?.outputFormat).toBe("pcm");
    expect(requests[0]?.sampleRateHz).toBe(16_000);
    expect(frames).toEqual([
      {
        type: "tts_audio",
        contentType: "audio/pcm",
        sampleRate: 16_000,
        dataBase64: Buffer.from("pcm-one!").toString("base64"),
      },
      {
        type: "tts_audio",
        contentType: "audio/pcm",
        sampleRate: 16_000,
        dataBase64: Buffer.from("pcm-two!").toString("base64"),
      },
    ]);
    expect(result).toEqual({
      provider: "elevenlabs",
      contentType: "audio/pcm",
      sampleRate: 16_000,
      chunks: 2,
      bytes: Buffer.byteLength("pcm-one!pcm-two!"),
    });
  });

  test("carries a trailing odd byte into the next PCM chunk to keep frames sample-aligned", async () => {
    config = makeConfig({ provider: "elevenlabs" });
    _setTtsProviderForTests({
      id: "elevenlabs",
      capabilities: {
        supportsStreaming: true,
        supportedFormats: ["mp3", "pcm"],
      },
      async synthesize(): Promise<TtsSynthesisResult> {
        throw new Error("buffered synthesis should not be used");
      },
      async synthesizeStream(
        _request: TtsSynthesisRequest,
        onChunk: (chunk: Uint8Array) => void,
      ): Promise<TtsSynthesisResult> {
        onChunk(Buffer.from([1, 2, 3]));
        onChunk(Buffer.from([4, 5, 6, 7, 8]));
        return {
          audio: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
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

    expect(frames.map((frame) => frame.dataBase64)).toEqual([
      Buffer.from([1, 2]).toString("base64"),
      Buffer.from([3, 4, 5, 6, 7, 8]).toString("base64"),
    ]);
    expect(result).toMatchObject({ chunks: 2, bytes: 8 });
  });

  test("drops a dangling final odd byte instead of emitting a torn PCM sample", async () => {
    config = makeConfig({ provider: "elevenlabs" });
    _setTtsProviderForTests({
      id: "elevenlabs",
      capabilities: {
        supportsStreaming: true,
        supportedFormats: ["mp3", "pcm"],
      },
      async synthesize(): Promise<TtsSynthesisResult> {
        throw new Error("buffered synthesis should not be used");
      },
      async synthesizeStream(
        _request: TtsSynthesisRequest,
        onChunk: (chunk: Uint8Array) => void,
      ): Promise<TtsSynthesisResult> {
        onChunk(Buffer.from([1, 2, 3]));
        return {
          audio: Buffer.from([1, 2, 3]),
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

    expect(frames.map((frame) => frame.dataBase64)).toEqual([
      Buffer.from([1, 2]).toString("base64"),
    ]);
    expect(result).toMatchObject({ chunks: 1, bytes: 2 });
  });

  test("skips the buffered non-PCM emit when the signal aborts mid-stream", async () => {
    const controller = new AbortController();
    _setTtsProviderForTests({
      id: "fish-audio",
      capabilities: {
        supportsStreaming: true,
        supportedFormats: ["mp3", "wav", "opus"],
      },
      async synthesize(): Promise<TtsSynthesisResult> {
        throw new Error("buffered synthesis should not be used");
      },
      async synthesizeStream(
        _request: TtsSynthesisRequest,
        onChunk: (chunk: Uint8Array) => void,
      ): Promise<TtsSynthesisResult> {
        onChunk(Buffer.from("chunk-one"));
        // Let the deferred emit flush so chunk-one is actually buffered
        // before the abort lands.
        await new Promise((resolve) => setTimeout(resolve, 0));
        controller.abort();
        onChunk(Buffer.from("chunk-two"));
        return {
          audio: Buffer.from("chunk-onechunk-two"),
          contentType: "audio/mpeg",
        };
      },
    });

    const frames: LiveVoiceTtsAudioChunk[] = [];
    const result = await streamLiveVoiceTtsAudio({
      config,
      text: "hello from live voice",
      signal: controller.signal,
      onAudioChunk: (chunk) => frames.push(chunk),
    });

    expect(frames).toEqual([]);
    expect(result).toMatchObject({
      provider: "fish-audio",
      chunks: 0,
      bytes: 0,
    });
  });

  test("returns a typed configuration error for a non-streaming provider", async () => {
    config = makeConfig({ provider: "elevenlabs" });
    _setTtsProviderForTests({
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
    _setTtsProviderForTests({
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
    _setTtsProviderForTests({
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

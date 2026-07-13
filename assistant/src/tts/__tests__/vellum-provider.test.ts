import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockSynthesizeResult: unknown;
let synthesizeCalls: Array<{
  text: string;
  format: string;
  signal?: AbortSignal;
}> = [];

mock.module("../../platform/managed-speech.js", () => ({
  managedSpeechSynthesize: async (input: {
    text: string;
    format: string;
    signal?: AbortSignal;
  }) => {
    synthesizeCalls.push(input);
    return mockSynthesizeResult;
  },
}));

let mockRelayConnection: {
  wsBaseUrl: string;
  httpBaseUrl: string;
  mintServiceToken: () => string;
} | null = null;

mock.module(
  "../../providers/speech-to-text/vellum-speech-relay-connection.js",
  () => ({
    resolveSpeechRelayConnection: async () => mockRelayConnection,
    mapVelayError: (e: { code: string }) => ({
      category: "provider-error",
      message: `mapped:${e.code}`,
    }),
    probeVelayRejection: async () => mockProbeRejection,
  }),
);
let mockProbeRejection: { code: string; detail?: string } | null = null;

let socketCalls: Array<{ url: string; text: string }> = [];
let mockSocketResult: () => Promise<Buffer> = async () => Buffer.from("pcm");

mock.module("../providers/vellum-tts-socket.js", () => ({
  synthesizeOverVellumTtsSocket: async (opts: {
    url: string;
    text: string;
    onChunk?: (c: Uint8Array) => void;
  }) => {
    socketCalls.push({ url: opts.url, text: opts.text });
    const audio = await mockSocketResult();
    opts.onChunk?.(audio);
    return audio;
  },
}));

import {
  createVellumProvider,
  vellumTtsProviderDefinition,
} from "../providers/vellum-provider.js";
import type { TtsSynthesisRequest } from "../types.js";

const MP3_BYTES = Buffer.from([0x49, 0x44, 0x33]);

function request(
  overrides: Partial<TtsSynthesisRequest> = {},
): TtsSynthesisRequest {
  return {
    text: "hello",
    useCase: "message-playback",
    ...overrides,
  } as TtsSynthesisRequest;
}

describe("vellum TTS adapter", () => {
  beforeEach(() => {
    synthesizeCalls = [];
    socketCalls = [];
    mockProbeRejection = null;
    mockSocketResult = async () => Buffer.from("pcm");
    mockRelayConnection = {
      wsBaseUrl: "ws://gateway.test",
      httpBaseUrl: "http://gateway.test",
      mintServiceToken: () => "tok-1",
    };
    mockSynthesizeResult = {
      ok: true,
      value: { audio: MP3_BYTES, contentType: "audio/mpeg" },
    };
  });

  test("message playback synthesizes mp3 and round-trips audio", async () => {
    const provider = createVellumProvider();
    const result = await provider.synthesize(request());

    expect(synthesizeCalls).toEqual([{ text: "hello", format: "mp3" }]);
    expect(Buffer.compare(result.audio, MP3_BYTES)).toBe(0);
    expect(result.contentType).toBe("audio/mpeg");
  });

  test("PCM hint maps to the platform's fixed 16 kHz PCM format", async () => {
    const provider = createVellumProvider();
    await provider.synthesize(request({ outputFormat: "pcm" }));

    expect(synthesizeCalls[0].format).toBe("pcm_16000");
    expect(
      provider.resolveOutputSampleRateHz?.(request({ outputFormat: "pcm" })),
    ).toBe(16000);
    // Contract: undefined for non-PCM output.
    expect(provider.resolveOutputSampleRateHz?.(request())).toBeUndefined();
  });

  test("forwards the abort signal to the platform call", async () => {
    const controller = new AbortController();
    const provider = createVellumProvider();
    await provider.synthesize(request({ signal: controller.signal }));

    expect(synthesizeCalls[0].signal).toBe(controller.signal);
  });

  test("insufficient balance throws a top-up message", async () => {
    mockSynthesizeResult = {
      ok: false,
      kind: "platform-error",
      status: 402,
      code: "insufficient_balance",
      message: "balance",
    };
    const provider = createVellumProvider();
    await expect(provider.synthesize(request())).rejects.toThrow(
      /Vellum credits/,
    );
  });

  test("unavailable platform throws a connect-your-account message", async () => {
    mockSynthesizeResult = {
      ok: false,
      kind: "unavailable",
      message: "No Vellum platform connection.",
    };
    const provider = createVellumProvider();
    await expect(provider.synthesize(request())).rejects.toThrow(
      /platform connect/,
    );
  });
});

describe("vellum TTS streaming", () => {
  beforeEach(() => {
    synthesizeCalls = [];
    socketCalls = [];
    mockProbeRejection = null;
    mockSocketResult = async () => Buffer.from("pcm");
    mockRelayConnection = {
      wsBaseUrl: "ws://gateway.test",
      httpBaseUrl: "http://gateway.test",
      mintServiceToken: () => "tok-1",
    };
    mockSynthesizeResult = {
      ok: true,
      value: { audio: MP3_BYTES, contentType: "audio/mpeg" },
    };
  });

  test("PCM streaming dials the gateway relay with token and audio params", async () => {
    const provider = createVellumProvider();
    const chunks: Uint8Array[] = [];

    const result = await provider.synthesizeStream!(
      request({ outputFormat: "pcm" }),
      (c) => chunks.push(c),
    );

    expect(socketCalls).toHaveLength(1);
    const url = new URL(socketCalls[0]!.url);
    expect(url.origin).toBe("ws://gateway.test");
    expect(url.pathname).toBe("/v1/speech/tts/stream");
    expect(url.searchParams.get("key")).toBe("tok-1");
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(result.contentType).toBe("audio/pcm");
    expect(chunks).toHaveLength(1);
    // Batch path untouched.
    expect(synthesizeCalls).toHaveLength(0);
  });

  test("non-PCM streaming delegates to the batch path with one chunk", async () => {
    const provider = createVellumProvider();
    const chunks: Uint8Array[] = [];

    const result = await provider.synthesizeStream!(request(), (c) =>
      chunks.push(c),
    );

    expect(socketCalls).toHaveLength(0);
    expect(synthesizeCalls).toEqual([{ text: "hello", format: "mp3" }]);
    expect(result.contentType).toBe("audio/mpeg");
    expect(chunks).toHaveLength(1);
  });

  test("a rejected dial surfaces the relay's mapped rejection via the probe", async () => {
    mockSocketResult = async () => {
      throw new Error("socket closed before Flushed");
    };
    mockProbeRejection = { code: "insufficient_balance" };
    const provider = createVellumProvider();

    await expect(
      provider.synthesizeStream!(request({ outputFormat: "pcm" }), () => {}),
    ).rejects.toThrow("mapped:insufficient_balance");
  });

  test("no relay connection throws a connect-your-account message", async () => {
    mockRelayConnection = null;
    const provider = createVellumProvider();

    await expect(
      provider.synthesizeStream!(request({ outputFormat: "pcm" }), () => {}),
    ).rejects.toThrow(/platform connect/);
  });

  test("streaming capability is advertised", () => {
    expect(createVellumProvider().capabilities.supportsStreaming).toBe(true);
  });
});

describe("vellum TTS definition", () => {
  test("declares streaming synthesized-play with PCM media-stream playback", () => {
    expect(vellumTtsProviderDefinition.capabilities.supportsStreaming).toBe(
      true,
    );
    expect(vellumTtsProviderDefinition.callMode).toBe("synthesized-play");
    expect(vellumTtsProviderDefinition.allowNativeFallback).toBe(false);
    expect(vellumTtsProviderDefinition.mediaStreamPlayback.outputFormat).toBe(
      "pcm",
    );
    expect(vellumTtsProviderDefinition.supportsVoiceSelection).toBe(false);
  });

  test("requires only the platform connection credential", () => {
    expect(vellumTtsProviderDefinition.secretRequirements).toEqual([
      {
        credentialStoreKey: "credential/vellum/assistant_api_key",
        displayName: "Vellum account connection",
        setCommand: "assistant platform connect",
      },
    ]);
  });
});

import { beforeEach, describe, expect, mock, test } from "bun:test";

let mockSynthesizeResult: unknown;
let synthesizeCalls: Array<{ text: string; format: string }> = [];

mock.module("../../platform/managed-speech.js", () => ({
  managedSpeechSynthesize: async (input: { text: string; format: string }) => {
    synthesizeCalls.push(input);
    return mockSynthesizeResult;
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
    expect(provider.resolveOutputSampleRateHz?.(request())).toBe(16000);
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

describe("vellum TTS definition", () => {
  test("declares batch-only synthesized-play with PCM media-stream playback", () => {
    expect(vellumTtsProviderDefinition.capabilities.supportsStreaming).toBe(
      false,
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

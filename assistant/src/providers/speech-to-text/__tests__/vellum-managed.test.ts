import { beforeEach, describe, expect, mock, test } from "bun:test";

import { SttError } from "../../../stt/types.js";

let mockTranscribeResult: unknown;
let mockClient: { platformAssistantId: string } | null = null;

mock.module("../../../platform/managed-speech.js", () => ({
  managedSpeechTranscribe: async () => mockTranscribeResult,
}));

mock.module("../../../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => mockClient,
  },
}));

import {
  sttErrorFromManagedSpeech,
  vellumManagedSpeechAvailable,
  vellumManagedTranscribe,
} from "../vellum-managed.js";

describe("vellumManagedSpeechAvailable", () => {
  test("true with a connected platform client", async () => {
    mockClient = { platformAssistantId: "asst-1" };
    expect(await vellumManagedSpeechAvailable()).toBe(true);
  });

  test("false without a client or without an assistant ID", async () => {
    mockClient = null;
    expect(await vellumManagedSpeechAvailable()).toBe(false);
    mockClient = { platformAssistantId: "" };
    expect(await vellumManagedSpeechAvailable()).toBe(false);
  });
});

describe("vellumManagedTranscribe", () => {
  beforeEach(() => {
    mockClient = { platformAssistantId: "asst-1" };
  });

  test("returns the transcription text", async () => {
    mockTranscribeResult = {
      ok: true,
      value: { text: "hello", durationSeconds: 2 },
    };
    expect(
      await vellumManagedTranscribe(Buffer.from([1]), "audio/wav"),
    ).toEqual({ text: "hello" });
  });

  test("throws a normalized SttError on failure", async () => {
    mockTranscribeResult = {
      ok: false,
      kind: "platform-error",
      status: 429,
      message: "slow down",
    };
    await expect(
      vellumManagedTranscribe(Buffer.from([1]), "audio/wav"),
    ).rejects.toMatchObject({ name: "SttError", category: "rate-limit" });
  });
});

describe("sttErrorFromManagedSpeech", () => {
  const cases: Array<{
    failure: Record<string, unknown>;
    category: string;
    messageIncludes?: string;
  }> = [
    {
      failure: { ok: false, kind: "unavailable", message: "no connection" },
      category: "auth",
    },
    {
      failure: {
        ok: false,
        kind: "platform-error",
        status: 402,
        code: "insufficient_balance",
        message: "balance",
      },
      category: "provider-error",
      messageIncludes: "Vellum credits",
    },
    {
      failure: { ok: false, kind: "platform-error", status: 401, message: "m" },
      category: "auth",
    },
    {
      failure: { ok: false, kind: "platform-error", status: 403, message: "m" },
      category: "auth",
    },
    {
      failure: { ok: false, kind: "platform-error", status: 429, message: "m" },
      category: "rate-limit",
    },
    {
      failure: { ok: false, kind: "platform-error", status: 413, message: "m" },
      category: "invalid-audio",
    },
    {
      failure: { ok: false, kind: "platform-error", status: 502, message: "m" },
      category: "provider-error",
    },
  ];

  for (const { failure, category, messageIncludes } of cases) {
    test(`${failure.kind}/${String(failure.code ?? failure.status ?? "-")} → ${category}`, () => {
      const err = sttErrorFromManagedSpeech(
        failure as Parameters<typeof sttErrorFromManagedSpeech>[0],
      );
      expect(err).toBeInstanceOf(SttError);
      expect(err.category).toBe(category as SttError["category"]);
      if (messageIncludes) {
        expect(err.message).toContain(messageIncludes);
      }
    });
  }
});

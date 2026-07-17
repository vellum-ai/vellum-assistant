import { beforeEach, describe, expect, mock, test } from "bun:test";

import { SttError } from "../../../stt/types.js";
import { describeSttFailure } from "../../voice-error-copy.js";

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
    name: string;
    failure: Record<string, unknown>;
    category: string;
    userFacing: boolean;
    messageIncludes?: string;
  }> = [
    {
      name: "unavailable → auth, user-facing reconnect copy",
      failure: { ok: false, kind: "unavailable", message: "no connection" },
      category: "auth",
      userFacing: true,
      messageIncludes: "no connection",
    },
    {
      name: "insufficient_balance → provider-error, user-facing credit copy",
      failure: {
        ok: false,
        kind: "platform-error",
        status: 402,
        code: "insufficient_balance",
        message: "balance",
      },
      category: "provider-error",
      userFacing: true,
      messageIncludes: "Vellum credits",
    },
    // Platform-supplied `detail` present: real remediation, surfaced verbatim.
    {
      name: "401 with platform detail → auth, user-facing verbatim",
      failure: {
        ok: false,
        kind: "platform-error",
        status: 401,
        detail: "Your session expired.",
        message: "Your session expired.",
      },
      category: "auth",
      userFacing: true,
      messageIncludes: "session expired",
    },
    {
      name: "429 with platform detail → rate-limit, user-facing verbatim",
      failure: {
        ok: false,
        kind: "platform-error",
        status: 429,
        detail: "Too many requests, retry in 30s.",
        message: "Too many requests, retry in 30s.",
      },
      category: "rate-limit",
      userFacing: true,
      messageIncludes: "retry in 30s",
    },
    {
      name: "413 with platform detail → invalid-audio, user-facing verbatim",
      failure: {
        ok: false,
        kind: "platform-error",
        status: 413,
        detail: "Audio exceeds the 25 MB limit.",
        message: "Audio exceeds the 25 MB limit.",
      },
      category: "invalid-audio",
      userFacing: true,
      messageIncludes: "25 MB",
    },
    // No platform `detail`: the generic "(platform returned N)" fallback stays
    // non-user-facing so describeSttFailure emits friendly category copy
    // instead of leaking a raw HTTP status.
    {
      name: "401 without detail → auth, not user-facing",
      failure: {
        ok: false,
        kind: "platform-error",
        status: 401,
        message: "Managed speech transcription failed (platform returned 401).",
      },
      category: "auth",
      userFacing: false,
    },
    {
      name: "403 without detail → auth, not user-facing",
      failure: {
        ok: false,
        kind: "platform-error",
        status: 403,
        message: "Managed speech transcription failed (platform returned 403).",
      },
      category: "auth",
      userFacing: false,
    },
    {
      name: "429 without detail → rate-limit, not user-facing",
      failure: {
        ok: false,
        kind: "platform-error",
        status: 429,
        message: "Managed speech transcription failed (platform returned 429).",
      },
      category: "rate-limit",
      userFacing: false,
    },
    {
      name: "413 without detail → invalid-audio, not user-facing",
      failure: {
        ok: false,
        kind: "platform-error",
        status: 413,
        message: "Managed speech transcription failed (platform returned 413).",
      },
      category: "invalid-audio",
      userFacing: false,
    },
    {
      name: "502 without detail → provider-error, not user-facing",
      failure: {
        ok: false,
        kind: "platform-error",
        status: 502,
        message: "Managed speech transcription failed (platform returned 502).",
      },
      category: "provider-error",
      userFacing: false,
    },
  ];

  for (const {
    name,
    failure,
    category,
    userFacing,
    messageIncludes,
  } of cases) {
    test(name, () => {
      const err = sttErrorFromManagedSpeech(
        failure as Parameters<typeof sttErrorFromManagedSpeech>[0],
      );
      expect(err).toBeInstanceOf(SttError);
      expect(err.category).toBe(category as SttError["category"]);
      // Verbatim only when the failure carries real remediation; a bare
      // HTTP-status fallback stays non-user-facing for friendly rewrite.
      expect(err.userFacing).toBe(userFacing);
      if (messageIncludes) {
        expect(err.message).toContain(messageIncludes);
      }
    });
  }
});

describe("describeSttFailure over managed STT failures", () => {
  test("surfaces a platform-supplied detail verbatim", () => {
    const err = sttErrorFromManagedSpeech({
      ok: false,
      kind: "platform-error",
      status: 429,
      detail: "Too many requests, retry in 30s.",
      message: "Too many requests, retry in 30s.",
    });
    expect(describeSttFailure(err, "vellum")).toBe(
      "Too many requests, retry in 30s.",
    );
  });

  test("replaces a bare HTTP-status fallback with friendly category copy", () => {
    const err = sttErrorFromManagedSpeech({
      ok: false,
      kind: "platform-error",
      status: 429,
      message: "Managed speech transcription failed (platform returned 429).",
    });
    const copy = describeSttFailure(err, "vellum");
    expect(copy).not.toContain("platform returned 429");
    expect(copy).toContain("rate-limiting");
  });
});

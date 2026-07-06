/**
 * Tests for the live-voice credential-readiness preflight resolver.
 *
 * The STT transcriber resolvers, secure-keys lookups, and config loader are
 * mocked so the readiness combination logic is exercised in isolation (the
 * real TTS provider catalog is used — provider ids like "fish-audio" and
 * "elevenlabs" carry their real streaming capabilities). `mock.module` is
 * process-global in Bun and leaks into sibling files that run later in the
 * same `bun test` invocation, so each stub delegates to the real
 * implementation unless this file's tests are active
 * (`preflightMocksActive`, toggled in beforeAll/afterAll). The real exports
 * are snapshotted into plain objects NOW, before the stubs register — a
 * module namespace is a live view, so reading the real export after the
 * stub installs would resolve back to the stub (infinite recursion).
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

let preflightMocksActive = false;

const realSttResolveModule = {
  ...(await import("../../providers/speech-to-text/resolve.js")),
};
const realSecureKeysModule = {
  ...(await import("../../security/secure-keys.js")),
};
const realConfigLoaderModule = {
  ...(await import("../../config/loader.js")),
};

// -- Mutable stub state --------------------------------------------------------

import type { ResolveStreamingTranscriberOptions } from "../../providers/speech-to-text/resolve.js";
import type {
  BatchTranscriber,
  StreamingTranscriber,
} from "../../stt/types.js";

let streamingTranscriber: StreamingTranscriber | null;
let resolveStreamingImpl: (
  options: ResolveStreamingTranscriberOptions,
) => Promise<StreamingTranscriber | null>;
let batchTranscriber: BatchTranscriber | null;
let providerKeys: Record<string, string>;
let sttProvider: string;
let ttsProvider: string;
let ttsProviderConfigs: Record<string, unknown>;

mock.module("../../providers/speech-to-text/resolve.js", () => ({
  ...realSttResolveModule,
  resolveStreamingTranscriber: async (
    options?: ResolveStreamingTranscriberOptions,
  ) =>
    preflightMocksActive
      ? resolveStreamingImpl(options ?? {})
      : realSttResolveModule.resolveStreamingTranscriber(options),
  resolveBatchTranscriber: async () =>
    preflightMocksActive
      ? batchTranscriber
      : realSttResolveModule.resolveBatchTranscriber(),
}));

mock.module("../../security/secure-keys.js", () => ({
  ...realSecureKeysModule,
  getProviderKeyAsync: async (provider: string) =>
    preflightMocksActive
      ? providerKeys[provider]
      : realSecureKeysModule.getProviderKeyAsync(provider),
  getSecureKeyAsync: async (account: string) =>
    preflightMocksActive
      ? undefined
      : realSecureKeysModule.getSecureKeyAsync(account),
}));

mock.module("../../config/loader.js", () => ({
  ...realConfigLoaderModule,
  getConfig: () =>
    preflightMocksActive
      ? ({
          services: {
            stt: { provider: sttProvider },
            tts: { provider: ttsProvider, providers: ttsProviderConfigs },
          },
        } as unknown as ReturnType<typeof realConfigLoaderModule.getConfig>)
      : realConfigLoaderModule.getConfig(),
}));

import { resolveLiveVoiceCredentialReadiness } from "../live-voice-credential-preflight.js";

beforeAll(() => {
  preflightMocksActive = true;
});

afterAll(() => {
  preflightMocksActive = false;
});

beforeEach(() => {
  // Baseline: everything ready — a streaming STT transcriber resolves and
  // the streaming-capable fish-audio TTS provider has credentials and a
  // configured voice reference ID.
  streamingTranscriber = {} as StreamingTranscriber;
  resolveStreamingImpl = async () => streamingTranscriber;
  batchTranscriber = null;
  providerKeys = { deepgram: "test-key", "fish-audio": "test-key" };
  sttProvider = "deepgram";
  ttsProvider = "fish-audio";
  ttsProviderConfigs = { "fish-audio": { referenceId: "ref_test" } };
});

function expectNotReady(
  readiness: Awaited<ReturnType<typeof resolveLiveVoiceCredentialReadiness>>,
) {
  expect(readiness.status).toBe("not-ready");
  if (readiness.status !== "not-ready") {
    throw new Error("expected not-ready");
  }
  return readiness;
}

describe("resolveLiveVoiceCredentialReadiness", () => {
  test("streaming STT + streaming TTS with credentials → ready", async () => {
    const readiness = await resolveLiveVoiceCredentialReadiness();
    expect(readiness).toEqual({ status: "ready" });
  });

  test("no streaming STT but a batch transcriber resolves (fallback mode) → still ready", async () => {
    streamingTranscriber = null;
    batchTranscriber = {} as BatchTranscriber;

    const readiness = await resolveLiveVoiceCredentialReadiness();
    expect(readiness).toEqual({ status: "ready" });
  });

  test("STT leg attempts the same streaming tiers as the ingest: boundary finals, then plain", async () => {
    const calls: ResolveStreamingTranscriberOptions[] = [];
    resolveStreamingImpl = async (options) => {
      calls.push(options);
      // Boundary tier unavailable (e.g. openai-whisper); plain tier works.
      return options.utteranceBoundaryFinals
        ? null
        : ({} as StreamingTranscriber);
    };

    const readiness = await resolveLiveVoiceCredentialReadiness();
    expect(readiness).toEqual({ status: "ready" });
    expect(calls.map((o) => Boolean(o.utteranceBoundaryFinals))).toEqual([
      true,
      false,
    ]);
  });

  test("STT credentials missing → not-ready with an stt entry naming the credential provider", async () => {
    streamingTranscriber = null;
    batchTranscriber = null;
    delete providerKeys.deepgram;

    const readiness = expectNotReady(
      await resolveLiveVoiceCredentialReadiness(),
    );
    expect(readiness.missing).toEqual([
      {
        kind: "stt",
        providerId: "deepgram",
        reason: 'No API key configured for credential provider "deepgram"',
      },
    ]);
    expect(readiness.userMessage).toContain('"deepgram"');
    expect(readiness.userMessage).toContain("speech-to-text");
  });

  test("unknown STT provider → not-ready with a catalog gap naming the configured id", async () => {
    streamingTranscriber = null;
    batchTranscriber = null;
    sttProvider = "acme-stt";

    const readiness = expectNotReady(
      await resolveLiveVoiceCredentialReadiness(),
    );
    expect(readiness.missing).toEqual([
      {
        kind: "stt",
        providerId: "acme-stt",
        reason: 'STT provider "acme-stt" is not in the provider catalog',
      },
    ]);
    expect(readiness.userMessage).toContain('"acme-stt"');
  });

  test("keyed STT provider that resolves neither transcriber → not-ready with a capability gap", async () => {
    streamingTranscriber = null;
    batchTranscriber = null;

    const readiness = expectNotReady(
      await resolveLiveVoiceCredentialReadiness(),
    );
    expect(readiness.missing).toEqual([
      {
        kind: "stt",
        providerId: "deepgram",
        reason:
          'STT provider "deepgram" supports neither streaming nor batch transcription',
      },
    ]);
    expect(readiness.userMessage).toContain("live transcription");
  });

  test("non-streaming TTS provider → not-ready with a tts entry naming the provider", async () => {
    ttsProvider = "elevenlabs";
    providerKeys.elevenlabs = "test-key";

    const readiness = expectNotReady(
      await resolveLiveVoiceCredentialReadiness(),
    );
    expect(readiness.missing).toEqual([
      {
        kind: "tts",
        providerId: "elevenlabs",
        reason:
          'TTS provider "elevenlabs" does not support streaming synthesis',
      },
    ]);
    expect(readiness.userMessage).toContain('"elevenlabs"');
    expect(readiness.userMessage).toContain("streaming synthesis");
  });

  test("streaming TTS provider missing credentials → not-ready naming the missing key", async () => {
    delete providerKeys["fish-audio"];

    const readiness = expectNotReady(
      await resolveLiveVoiceCredentialReadiness(),
    );
    expect(readiness.missing).toEqual([
      {
        kind: "tts",
        providerId: "fish-audio",
        reason:
          'TTS provider "fish-audio" is missing credentials (Fish Audio API Key)',
      },
    ]);
    expect(readiness.userMessage).toContain('"fish-audio"');
    expect(readiness.userMessage).toContain("text-to-speech");
    expect(readiness.userMessage).toContain("Fish Audio API Key");
  });

  test("fish-audio with credentials but no referenceId → not-ready naming the missing reference ID", async () => {
    ttsProviderConfigs = {};

    const readiness = expectNotReady(
      await resolveLiveVoiceCredentialReadiness(),
    );
    expect(readiness.missing).toEqual([
      {
        kind: "tts",
        providerId: "fish-audio",
        reason:
          'TTS provider "fish-audio" has no Fish Audio reference ID configured (services.tts.providers.fish-audio.referenceId)',
      },
    ]);
    expect(readiness.userMessage).toContain("Fish Audio voice reference ID");
    expect(readiness.userMessage).toContain(
      "services.tts.providers.fish-audio.referenceId",
    );
  });

  test("unknown TTS provider → not-ready with a catalog gap naming the configured id", async () => {
    ttsProvider = "acme-tts";

    const readiness = expectNotReady(
      await resolveLiveVoiceCredentialReadiness(),
    );
    expect(readiness.missing).toEqual([
      {
        kind: "tts",
        providerId: "acme-tts",
        reason: 'TTS provider "acme-tts" is not in the provider catalog',
      },
    ]);
    expect(readiness.userMessage).toContain('"acme-tts"');
  });

  test("both STT and TTS missing → both entries, message names both providers", async () => {
    streamingTranscriber = null;
    batchTranscriber = null;
    delete providerKeys.deepgram;
    delete providerKeys["fish-audio"];

    const readiness = expectNotReady(
      await resolveLiveVoiceCredentialReadiness(),
    );
    expect(readiness.missing.map((gap) => gap.kind)).toEqual(["stt", "tts"]);
    expect(readiness.userMessage).toContain('"deepgram"');
    expect(readiness.userMessage).toContain('"fish-audio"');
    // Single sentence: suitable for the client `error` frame.
    expect(readiness.userMessage).not.toContain("\n");
    expect(readiness.userMessage.endsWith(".")).toBe(true);
  });
});

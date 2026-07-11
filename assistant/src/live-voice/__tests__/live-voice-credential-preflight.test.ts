/**
 * Tests for the live-voice credential-readiness preflight resolver.
 *
 * The STT streaming-transcriber resolver and secure-keys lookups are mocked
 * so the readiness combination logic is exercised in isolation (the real TTS
 * provider catalog is used — every catalog provider supports streaming, so
 * the non-streaming TTS case shadows the "xai" adapter via the catalog's
 * `_setTtsProviderForTests` override seam). `mock.module` is process-global
 * in Bun and leaks into sibling files that run later in the same `bun test`
 * invocation, so each stub delegates to the real implementation unless this
 * file's tests are active (`preflightMocksActive`, toggled in
 * beforeAll/afterAll). The real exports are snapshotted into plain objects
 * NOW, before the stubs register — a module namespace is a live view, so
 * reading the real export after the stub installs would resolve back to the
 * stub (infinite recursion).
 *
 * The `services.stt`/`services.tts` provider selection is seeded for real via
 * `setConfig`. Because two tests configure provider ids the enum schema would
 * strip ("acme-stt"/"acme-tts"), `runReadiness` seeds a schema-valid baseline
 * and then overwrites `services` on the live cached config object so those
 * unrecognized ids reach the resolver unchanged.
 */

import {
  afterAll,
  afterEach,
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

// -- Mutable stub state --------------------------------------------------------

import type { StreamingTranscriber } from "../../stt/types.js";

let streamingTranscriber: StreamingTranscriber | null;
let providerKeys: Record<string, string>;
let sttProvider: string;
let ttsProvider: string;
let ttsProviders: Record<string, unknown>;

mock.module("../../providers/speech-to-text/resolve.js", () => ({
  ...realSttResolveModule,
  resolveStreamingTranscriber: async () =>
    preflightMocksActive
      ? streamingTranscriber
      : realSttResolveModule.resolveStreamingTranscriber(),
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

import { setConfig } from "../../__tests__/helpers/set-config.js";
import { getConfig } from "../../config/loader.js";
import {
  _resetTtsProviderOverridesForTests,
  _setTtsProviderForTests,
  getTtsProvider,
} from "../../tts/provider-catalog.js";
import { resolveLiveVoiceCredentialReadiness } from "../live-voice-credential-preflight.js";

// Seed the current stt/tts provider selection for real, then run the resolver.
// A schema-valid baseline is seeded first so the loader caches a config
// object; `services` is then overwritten on that live cached object so
// provider ids the enum schema would strip (the "acme-*" cases) reach the
// resolver unchanged.
async function runReadiness(): Promise<
  Awaited<ReturnType<typeof resolveLiveVoiceCredentialReadiness>>
> {
  setConfig("services", {
    stt: { provider: "deepgram", providers: {} },
    tts: { provider: "fish-audio", providers: {} },
  });
  const services = getConfig().services as {
    stt: unknown;
    tts: unknown;
  };
  services.stt = { provider: sttProvider, providers: {} };
  services.tts = { provider: ttsProvider, providers: ttsProviders };
  return resolveLiveVoiceCredentialReadiness();
}

beforeAll(() => {
  preflightMocksActive = true;
});

afterAll(() => {
  preflightMocksActive = false;
});

afterEach(() => {
  _resetTtsProviderOverridesForTests();
});

beforeEach(() => {
  // Baseline: everything ready — a streaming STT transcriber resolves and
  // the streaming-capable fish-audio TTS provider has credentials plus a
  // configured voice reference ID.
  streamingTranscriber = {} as StreamingTranscriber;
  providerKeys = { deepgram: "test-key", "fish-audio": "test-key" };
  sttProvider = "deepgram";
  ttsProvider = "fish-audio";
  ttsProviders = { "fish-audio": { referenceId: "ref-123" } };
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
    const readiness = await runReadiness();
    expect(readiness).toEqual({ status: "ready" });
  });

  test("STT credentials missing → not-ready with an stt entry naming the credential provider", async () => {
    streamingTranscriber = null;
    delete providerKeys.deepgram;

    const readiness = expectNotReady(await runReadiness());
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
    sttProvider = "acme-stt";

    const readiness = expectNotReady(await runReadiness());
    expect(readiness.missing).toEqual([
      {
        kind: "stt",
        providerId: "acme-stt",
        reason: 'STT provider "acme-stt" is not in the provider catalog',
      },
    ]);
    expect(readiness.userMessage).toContain('"acme-stt"');
  });

  test("keyed STT provider that resolves no streaming transcriber → not-ready with a capability gap", async () => {
    streamingTranscriber = null;

    const readiness = expectNotReady(await runReadiness());
    expect(readiness.missing).toEqual([
      {
        kind: "stt",
        providerId: "deepgram",
        reason:
          'STT provider "deepgram" does not support streaming transcription',
      },
    ]);
    expect(readiness.userMessage).toContain("live transcription");
  });

  test("non-streaming TTS provider → not-ready with a tts entry naming the provider", async () => {
    ttsProvider = "xai";
    providerKeys.xai = "test-key";
    const realXai = getTtsProvider("xai");
    _setTtsProviderForTests({
      ...realXai,
      capabilities: { ...realXai.capabilities, supportsStreaming: false },
    });

    const readiness = expectNotReady(await runReadiness());
    expect(readiness.missing).toEqual([
      {
        kind: "tts",
        providerId: "xai",
        reason: 'TTS provider "xai" does not support streaming synthesis',
      },
    ]);
    expect(readiness.userMessage).toContain('"xai"');
    expect(readiness.userMessage).toContain("streaming synthesis");
  });

  test("streaming TTS provider missing credentials → not-ready naming the missing key", async () => {
    delete providerKeys["fish-audio"];

    const readiness = expectNotReady(await runReadiness());
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

  test("fish-audio keyed but referenceId-less → not-ready naming the reference ID", async () => {
    ttsProviders = {};

    const readiness = expectNotReady(await runReadiness());
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

    const readiness = expectNotReady(await runReadiness());
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
    delete providerKeys.deepgram;
    delete providerKeys["fish-audio"];

    const readiness = expectNotReady(await runReadiness());
    expect(readiness.missing.map((gap) => gap.kind)).toEqual(["stt", "tts"]);
    expect(readiness.userMessage).toContain('"deepgram"');
    expect(readiness.userMessage).toContain('"fish-audio"');
    // Single sentence: suitable for the client `error` frame.
    expect(readiness.userMessage).not.toContain("\n");
    expect(readiness.userMessage.endsWith(".")).toBe(true);
  });
});

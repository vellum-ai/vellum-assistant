/**
 * Live voice on managed speech without a config write.
 *
 * `/v1/live-voice` validates guardian identity only — it does not enforce the
 * caller's `settings.write` scope — so the WebSocket transport must never
 * persist `services.stt/tts.provider`. Instead every live-voice leg resolves
 * the EFFECTIVE providers: while managed speech is available, a configured
 * BYOK provider whose credential does not resolve is served by `"vellum"`.
 * These tests pin both halves of that contract — the readiness verdict and
 * the runtime legs agree, and `config.json` is byte-identical afterwards.
 *
 * `mock.module` is process-global in Bun and leaks into sibling files that run
 * later in the same `bun test` invocation, so each stub delegates to the real
 * implementation unless this file's tests are active (`fallbackMocksActive`,
 * toggled in beforeAll/afterAll). Run this file on its own.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

import type { ResolveStreamingTranscriberOptions } from "../../providers/speech-to-text/resolve.js";
import type { StreamingTranscriber } from "../../stt/types.js";

let fallbackMocksActive = false;

const realSttResolveModule = {
  ...(await import("../../providers/speech-to-text/resolve.js")),
};
const realSecureKeysModule = {
  ...(await import("../../security/secure-keys.js")),
};
const realManagedSpeechModule = {
  ...(await import("../../platform/managed-speech.js")),
};

// -- Mutable stub state -------------------------------------------------------

/** Whether the platform connection can serve managed speech. */
let managedAvailable = false;
/** Credential-store keys that resolve to a value. */
let providerKeys: Record<string, string>;
/** Provider ids `resolveStreamingTranscriber` was asked for, in call order. */
let requestedSttProviders: (string | undefined)[];

/** A provider yields a streaming transcriber when its credential resolves. */
function transcriberFor(providerId: string | undefined): boolean {
  return providerId === "vellum"
    ? managedAvailable
    : providerId !== undefined && providerKeys[providerId] !== undefined;
}

mock.module("../../providers/speech-to-text/resolve.js", () => ({
  ...realSttResolveModule,
  resolveStreamingTranscriber: async (
    options: ResolveStreamingTranscriberOptions = {},
  ) => {
    if (!fallbackMocksActive) {
      return realSttResolveModule.resolveStreamingTranscriber(options);
    }
    requestedSttProviders.push(options.providerId);
    return transcriberFor(options.providerId)
      ? ({} as StreamingTranscriber)
      : null;
  },
}));

mock.module("../../security/secure-keys.js", () => ({
  ...realSecureKeysModule,
  getProviderKeyAsync: async (provider: string) =>
    fallbackMocksActive
      ? providerKeys[provider]
      : realSecureKeysModule.getProviderKeyAsync(provider),
  getSecureKeyAsync: async (account: string) =>
    fallbackMocksActive
      ? providerKeys[account]
      : realSecureKeysModule.getSecureKeyAsync(account),
}));

mock.module("../../platform/managed-speech.js", () => ({
  ...realManagedSpeechModule,
  managedSpeechAvailable: async () =>
    fallbackMocksActive
      ? managedAvailable
      : realManagedSpeechModule.managedSpeechAvailable(),
}));

import { getConfig, invalidateConfigCache } from "../../config/loader.js";
import { resolveEffectiveSpeechProviders } from "../../config/managed-speech-defaults.js";
import {
  _resetTtsProviderOverridesForTests,
  _setTtsProviderForTests,
} from "../../tts/provider-catalog.js";
import type {
  TtsProvider,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from "../../tts/types.js";
import { resolveLiveVoiceCredentialReadiness } from "../live-voice-credential-preflight.js";
import { streamLiveVoiceTtsAudio } from "../live-voice-tts.js";

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

/** Config with both speech services pointed at BYOK providers. */
const BYOK_CONFIG = {
  services: {
    stt: { provider: "deepgram", providers: {} },
    tts: { provider: "elevenlabs", providers: {} },
  },
};

function writeConfig(obj: unknown): void {
  if (!existsSync(WORKSPACE_DIR)) {
    mkdirSync(WORKSPACE_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(obj));
  invalidateConfigCache();
}

function readConfigFile(): string {
  return readFileSync(CONFIG_PATH, "utf8");
}

/** A streaming TTS adapter standing in for the managed `vellum` provider. */
function registerManagedTtsProvider(): TtsProvider {
  const provider: TtsProvider = {
    id: "vellum",
    capabilities: { supportsStreaming: true, supportedFormats: ["pcm", "mp3"] },
    async synthesize(): Promise<TtsSynthesisResult> {
      throw new Error("buffered synthesis should not be used");
    },
    async synthesizeStream(
      _request: TtsSynthesisRequest,
      onChunk: (chunk: Uint8Array) => void,
    ): Promise<TtsSynthesisResult> {
      onChunk(Buffer.from("managed!"));
      return { audio: Buffer.from("managed!"), contentType: "audio/pcm" };
    },
  };
  _setTtsProviderForTests(provider);
  return provider;
}

beforeAll(() => {
  fallbackMocksActive = true;
});

afterAll(() => {
  fallbackMocksActive = false;
});

afterEach(() => {
  _resetTtsProviderOverridesForTests();
});

beforeEach(() => {
  writeConfig(BYOK_CONFIG);
  managedAvailable = false;
  providerKeys = {};
  requestedSttProviders = [];
});

describe("live voice on managed speech", () => {
  test("unkeyed BYOK TTS resolves the managed provider and reports ready", async () => {
    managedAvailable = true;
    providerKeys = { deepgram: "test-key" };
    const configBefore = readConfigFile();

    const effective = await resolveEffectiveSpeechProviders();
    expect(effective).toEqual({ stt: "deepgram", tts: "vellum" });

    const readiness = await resolveLiveVoiceCredentialReadiness();
    expect(readiness).toEqual({ status: "ready" });

    expect(readConfigFile()).toBe(configBefore);
  });

  test("synthesis runs on the managed provider while the config still names the BYOK one", async () => {
    managedAvailable = true;
    providerKeys = { deepgram: "test-key" };
    registerManagedTtsProvider();
    const configBefore = readConfigFile();

    const chunks: string[] = [];
    const result = await streamLiveVoiceTtsAudio({
      text: "hello",
      config: getConfig(),
      onAudioChunk: (chunk) => {
        chunks.push(chunk.dataBase64);
      },
    });

    expect(result.provider).toBe("vellum");
    expect(chunks).toHaveLength(1);
    expect(getConfig().services.tts.provider).toBe("elevenlabs");
    expect(readConfigFile()).toBe(configBefore);
  });

  test("unkeyed BYOK STT resolves the managed provider and reports ready", async () => {
    managedAvailable = true;
    providerKeys = { elevenlabs: "test-key" };
    const configBefore = readConfigFile();

    const effective = await resolveEffectiveSpeechProviders();
    expect(effective).toEqual({ stt: "vellum", tts: "elevenlabs" });

    const readiness = await resolveLiveVoiceCredentialReadiness();
    expect(readiness).toEqual({ status: "ready" });

    // The transcriber the session arms is asked for the same provider the
    // readiness verdict was earned on.
    expect(requestedSttProviders).toEqual(["vellum"]);
    expect(readConfigFile()).toBe(configBefore);
  });

  test("managed speech unavailable keeps the configured providers and reports not-ready", async () => {
    managedAvailable = false;
    const configBefore = readConfigFile();

    const effective = await resolveEffectiveSpeechProviders();
    expect(effective).toEqual({ stt: "deepgram", tts: "elevenlabs" });

    const readiness = await resolveLiveVoiceCredentialReadiness();
    expect(readiness.status).toBe("not-ready");
    if (readiness.status !== "not-ready") {
      throw new Error("expected not-ready");
    }
    expect(readiness.missing.map((gap) => gap.providerId)).toEqual([
      "deepgram",
      "elevenlabs",
    ]);
    expect(requestedSttProviders).toEqual(["deepgram"]);
    expect(readConfigFile()).toBe(configBefore);
  });
});

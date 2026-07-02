/**
 * Tests for the telephony credential-readiness preflight resolver.
 *
 * The STT capability resolver, TTS capability resolver, TTS fallback
 * scanner, and config loader are mocked so the readiness combination logic
 * is exercised in isolation. `mock.module` is process-global in Bun and
 * leaks into sibling files that run later in the same `bun test`
 * invocation, so each stub delegates to the real implementation unless this
 * file's tests are active (`preflightMocksActive`, toggled in
 * beforeAll/afterAll). The real exports are snapshotted into plain objects
 * NOW, before the stubs register — a module namespace is a live view, so
 * reading the real export after the stub installs would resolve back to
 * the stub (infinite recursion).
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
  ...(await import("../providers/speech-to-text/resolve.js")),
};
const realTtsCapabilityModule = {
  ...(await import("../calls/telephony-tts-capability.js")),
};
const realCallTtsResolverModule = {
  ...(await import("../calls/resolve-call-tts-provider.js")),
};
const realConfigLoaderModule = { ...(await import("../config/loader.js")) };

// -- Mutable capability results -----------------------------------------------

import type { TelephonyTtsCapability } from "../calls/telephony-tts-capability.js";
import type { TelephonySttCapability } from "../providers/speech-to-text/resolve.js";
import type { TtsProviderId } from "../tts/types.js";

let sttCapability: TelephonySttCapability;
let ttsCapability: TelephonyTtsCapability;
let fallbackProviderId: TtsProviderId | null;
let fallbackScanCalls: Array<TtsProviderId | undefined> = [];

const testConfig = {
  services: { stt: { provider: "acme-stt" } },
} as unknown as ReturnType<typeof realConfigLoaderModule.getConfig>;

mock.module("../providers/speech-to-text/resolve.js", () => ({
  ...realSttResolveModule,
  resolveTelephonySttCapability: async () =>
    preflightMocksActive
      ? sttCapability
      : realSttResolveModule.resolveTelephonySttCapability(),
}));

mock.module("../calls/telephony-tts-capability.js", () => ({
  ...realTtsCapabilityModule,
  resolveTelephonyTtsCapability: async () =>
    preflightMocksActive
      ? ttsCapability
      : realTtsCapabilityModule.resolveTelephonyTtsCapability(),
}));

mock.module("../calls/resolve-call-tts-provider.js", () => ({
  ...realCallTtsResolverModule,
  findPlayableTelephonyTtsFallback: async (
    excludeProviderId?: TtsProviderId,
  ) => {
    if (!preflightMocksActive) {
      return realCallTtsResolverModule.findPlayableTelephonyTtsFallback(
        excludeProviderId,
      );
    }
    fallbackScanCalls.push(excludeProviderId);
    return fallbackProviderId;
  },
}));

mock.module("../config/loader.js", () => ({
  ...realConfigLoaderModule,
  getConfig: () =>
    preflightMocksActive ? testConfig : realConfigLoaderModule.getConfig(),
}));

import { resolveTelephonyCredentialReadiness } from "../calls/telephony-credential-preflight.js";

beforeAll(() => {
  preflightMocksActive = true;
});

afterAll(() => {
  preflightMocksActive = false;
});

beforeEach(() => {
  sttCapability = {
    status: "supported",
    providerId: "deepgram",
    telephonyMode: "realtime-ws",
  };
  ttsCapability = { status: "playable", providerId: "elevenlabs" };
  fallbackProviderId = null;
  fallbackScanCalls = [];
});

describe("resolveTelephonyCredentialReadiness", () => {
  test("STT supported + TTS playable → ready", async () => {
    const readiness = await resolveTelephonyCredentialReadiness();
    expect(readiness).toEqual({ status: "ready" });
    // A playable configured provider never triggers the fallback scan.
    expect(fallbackScanCalls).toEqual([]);
  });

  test("STT missing-credentials → not-ready with an stt entry naming the provider", async () => {
    sttCapability = {
      status: "missing-credentials",
      providerId: "deepgram",
      credentialProvider: "deepgram",
      reason: 'No API key configured for credential provider "deepgram"',
    };

    const readiness = await resolveTelephonyCredentialReadiness();
    expect(readiness.status).toBe("not-ready");
    if (readiness.status !== "not-ready") {
      throw new Error("expected not-ready");
    }
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

  test("STT unconfigured → not-ready with the configured provider id", async () => {
    sttCapability = {
      status: "unconfigured",
      reason: 'STT provider "acme-stt" is not in the provider catalog',
    };

    const readiness = await resolveTelephonyCredentialReadiness();
    expect(readiness.status).toBe("not-ready");
    if (readiness.status !== "not-ready") {
      throw new Error("expected not-ready");
    }
    expect(readiness.missing).toEqual([
      {
        kind: "stt",
        providerId: "acme-stt",
        reason: 'STT provider "acme-stt" is not in the provider catalog',
      },
    ]);
    expect(readiness.userMessage).toContain('"acme-stt"');
  });

  test("STT unsupported → not-ready", async () => {
    sttCapability = {
      status: "unsupported",
      providerId: "openai-whisper",
      reason: 'STT provider "openai-whisper" does not support telephony',
    };

    const readiness = await resolveTelephonyCredentialReadiness();
    expect(readiness.status).toBe("not-ready");
    if (readiness.status !== "not-ready") {
      throw new Error("expected not-ready");
    }
    expect(readiness.missing).toEqual([
      {
        kind: "stt",
        providerId: "openai-whisper",
        reason: 'STT provider "openai-whisper" does not support telephony',
      },
    ]);
    expect(readiness.userMessage).toContain('"openai-whisper"');
  });

  test("TTS not-playable but a credentialed playable fallback exists → ready", async () => {
    ttsCapability = {
      status: "not-playable",
      providerId: "compressed-only" as TtsProviderId,
      reason: "unsupported-format",
    };
    fallbackProviderId = "elevenlabs";

    const readiness = await resolveTelephonyCredentialReadiness();
    expect(readiness).toEqual({ status: "ready" });
    // The scan excludes the configured provider.
    expect(fallbackScanCalls).toEqual(["compressed-only" as TtsProviderId]);
  });

  test("TTS not-playable with no fallback → not-ready with a tts entry naming the provider", async () => {
    ttsCapability = {
      status: "not-playable",
      providerId: "elevenlabs",
      reason: "missing-credentials",
    };

    const readiness = await resolveTelephonyCredentialReadiness();
    expect(readiness.status).toBe("not-ready");
    if (readiness.status !== "not-ready") {
      throw new Error("expected not-ready");
    }
    expect(readiness.missing).toEqual([
      {
        kind: "tts",
        providerId: "elevenlabs",
        reason:
          'TTS provider "elevenlabs" is missing credentials and no playable fallback provider is available',
      },
    ]);
    expect(readiness.userMessage).toContain('"elevenlabs"');
    expect(readiness.userMessage).toContain("text-to-speech");
  });

  test("TTS unsupported-format with no fallback → not-ready with a tts entry", async () => {
    ttsCapability = {
      status: "not-playable",
      providerId: "compressed-only" as TtsProviderId,
      reason: "unsupported-format",
    };

    const readiness = await resolveTelephonyCredentialReadiness();
    expect(readiness.status).toBe("not-ready");
    if (readiness.status !== "not-ready") {
      throw new Error("expected not-ready");
    }
    expect(readiness.missing).toEqual([
      {
        kind: "tts",
        providerId: "compressed-only",
        reason:
          'TTS provider "compressed-only" cannot produce media-stream-playable audio and no playable fallback provider is available',
      },
    ]);
    expect(readiness.userMessage).toContain('"compressed-only"');
  });

  test("both STT and TTS missing → both entries, message names both providers", async () => {
    sttCapability = {
      status: "missing-credentials",
      providerId: "deepgram",
      credentialProvider: "deepgram",
      reason: 'No API key configured for credential provider "deepgram"',
    };
    ttsCapability = {
      status: "not-playable",
      providerId: "elevenlabs",
      reason: "missing-credentials",
    };

    const readiness = await resolveTelephonyCredentialReadiness();
    expect(readiness.status).toBe("not-ready");
    if (readiness.status !== "not-ready") {
      throw new Error("expected not-ready");
    }
    expect(readiness.missing.map((gap) => gap.kind)).toEqual(["stt", "tts"]);
    expect(readiness.userMessage).toContain('"deepgram"');
    expect(readiness.userMessage).toContain('"elevenlabs"');
    // Single sentence: suitable for both a tool error and a TwiML <Say>.
    expect(readiness.userMessage).not.toContain("\n");
    expect(readiness.userMessage.endsWith(".")).toBe(true);
  });
});

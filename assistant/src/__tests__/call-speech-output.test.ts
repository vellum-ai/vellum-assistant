import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Logger mock (must come before any source imports) ────
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── Public ingress URL spy ───────────────────────────────────────────
// The media-stream path must NEVER reach for a public base URL. We track
// calls and preserve the production throw-on-empty behavior so a regression
// that re-introduces the play-URL path would surface here.
let getPublicBaseUrlCallCount = 0;

mock.module("../inbound/public-ingress-urls.js", () => ({
  getPublicBaseUrl: () => {
    getPublicBaseUrlCallCount++;
    throw new Error(
      "No public base URL configured. Set ingress.publicBaseUrl in config.",
    );
  },
}));

// ── Config loader mock ───────────────────────────────────────────────
mock.module("../config/loader.js", () => ({
  loadConfig: () => ({
    ingress: { enabled: true, publicBaseUrl: "" },
    services: { tts: { mode: "your-own", provider: "elevenlabs" } },
  }),
}));

// ── Audio store mock (must not be reached on the media-stream path) ──
let createStreamingEntryCallCount = 0;
mock.module("../calls/audio-store.js", () => ({
  createStreamingEntry: () => {
    createStreamingEntryCallCount++;
    return {
      audioId: "audio-test",
      push: () => {},
      finalize: () => {},
    };
  },
}));

// ── TTS provider resolution mocks ────────────────────────────────────
let resolvePlayableCallTtsProviderCallCount = 0;
let resolveCallTtsProviderCallCount = 0;

mock.module("../calls/resolve-call-tts-provider.js", () => ({
  resolveCallTtsProvider: () => {
    resolveCallTtsProviderCallCount++;
    return { provider: null, useSynthesizedPath: false, audioFormat: "mp3" };
  },
  resolvePlayableCallTtsProvider: async () => {
    resolvePlayableCallTtsProviderCallCount++;
    return { provider: null, audioFormat: "wav" };
  },
}));

mock.module("../tts/provider-catalog.js", () => ({
  getCatalogProvider: () => ({ allowNativeFallback: true }),
}));

// ── Import source modules after all mocks are registered ────────────
import { speakSystemPrompt } from "../calls/call-speech-output.js";
import type { CallTransport } from "../calls/call-transport.js";

interface MockTransport extends CallTransport {
  sentTokens: Array<{ token: string; last: boolean }>;
  sentPlayUrls: string[];
}

function createMockTransport(requiresWavAudio: boolean): MockTransport {
  const sentTokens: Array<{ token: string; last: boolean }> = [];
  const sentPlayUrls: string[] = [];
  return {
    requiresWavAudio,
    sentTokens,
    sentPlayUrls,
    sendTextToken(token: string, last: boolean) {
      sentTokens.push({ token, last });
    },
    sendPlayUrl(url: string) {
      sentPlayUrls.push(url);
    },
    endSession() {},
    getConnectionState() {
      return "connected";
    },
  } as MockTransport;
}

describe("speakSystemPrompt — media-stream transport", () => {
  beforeEach(() => {
    getPublicBaseUrlCallCount = 0;
    createStreamingEntryCallCount = 0;
    resolvePlayableCallTtsProviderCallCount = 0;
    resolveCallTtsProviderCallCount = 0;
  });

  test("hands the prompt text directly to sendTextToken(text, true)", async () => {
    const relay = createMockTransport(true);

    await speakSystemPrompt(relay, "Your verification code is 1234.");

    expect(relay.sentTokens).toEqual([
      { token: "Your verification code is 1234.", last: true },
    ]);
  });

  test("does NOT use the play-URL / public base URL path", async () => {
    const relay = createMockTransport(true);

    await speakSystemPrompt(relay, "Please hold while I connect you.");

    expect(relay.sentPlayUrls.length).toBe(0);
    expect(getPublicBaseUrlCallCount).toBe(0);
    expect(createStreamingEntryCallCount).toBe(0);
    // Provider resolution is delegated to MediaStreamOutput itself, so the
    // speech-output helper no longer resolves a playable provider here.
    expect(resolvePlayableCallTtsProviderCallCount).toBe(0);
  });

  test("works (no throw, audio emitted) when publicBaseUrl is empty", async () => {
    const relay = createMockTransport(true);

    // Should not throw despite the mocked getPublicBaseUrl throwing on empty.
    await speakSystemPrompt(relay, "Connecting you now.");

    expect(relay.sentTokens).toEqual([
      { token: "Connecting you now.", last: true },
    ]);
    expect(getPublicBaseUrlCallCount).toBe(0);
  });
});

describe("speakSystemPrompt — native (non-WAV) transport", () => {
  beforeEach(() => {
    getPublicBaseUrlCallCount = 0;
    resolveCallTtsProviderCallCount = 0;
  });

  test("native path sends text via sendTextToken(text, true)", async () => {
    const relay = createMockTransport(false);

    await speakSystemPrompt(relay, "This is a native prompt.");

    // resolveCallTtsProvider returns useSynthesizedPath:false -> native path.
    expect(resolveCallTtsProviderCallCount).toBe(1);
    expect(relay.sentTokens).toEqual([
      { token: "This is a native prompt.", last: true },
    ]);
    expect(relay.sentPlayUrls.length).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — must appear before any imports of the modules under test
// ---------------------------------------------------------------------------

// -- Config mock -----------------------------------------------------------

const mockConfig = {
  services: {
    tts: {
      provider: "elevenlabs",
      providers: {
        elevenlabs: { voiceId: "test-voice" },
        "fish-audio": { referenceId: "test-ref" },
      },
    },
  },
};

mock.module("../../../config/loader.js", () => ({
  getConfig: () => mockConfig,
}));

// -- TTS config resolver mock ----------------------------------------------

mock.module("../../../tts/tts-config-resolver.js", () => ({
  resolveTtsConfig: () => ({
    provider: mockConfig.services.tts.provider,
    providerConfig: {},
  }),
}));

// -- TTS text sanitizer mock -----------------------------------------------

mock.module("../../../calls/tts-text-sanitizer.js", () => ({
  sanitizeForTts: (text: string) => text,
}));

// -- synthesizeText mock ---------------------------------------------------

let mockSynthesizeResult: { audio: Buffer; contentType: string } = {
  audio: Buffer.from("fake-audio"),
  contentType: "audio/mpeg",
};
let mockSynthesizeError: Error | null = null;
let lastSynthesizeOptions: Record<string, unknown> | null = null;

class MockTtsSynthesisError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TtsSynthesisError";
    this.code = code;
  }
}

mock.module("../../../tts/synthesize-text.js", () => ({
  synthesizeText: async (options: Record<string, unknown>) => {
    lastSynthesizeOptions = options;
    if (mockSynthesizeError) throw mockSynthesizeError;
    return mockSynthesizeResult;
  },
  TtsSynthesisError: MockTtsSynthesisError,
}));

// ---------------------------------------------------------------------------
// Import under test — after mocks
// ---------------------------------------------------------------------------

import { RouteError } from "../errors.js";
import { formatTtsFailureMessage, ROUTES } from "../tts-routes.js";
import type { RouteHandlerArgs } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRoute(endpoint: string) {
  const route = ROUTES.find((r) => r.endpoint === endpoint);
  if (!route) throw new Error(`Route ${endpoint} not found`);
  return route;
}

function makeSynthesizeArgs(body: Record<string, unknown>): RouteHandlerArgs {
  return { body, headers: {} };
}

async function expectRouteError(
  fn: () => unknown,
  statusCode: number,
  code?: string,
) {
  try {
    await fn();
    throw new Error("Expected RouteError to be thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(RouteError);
    const re = err as InstanceType<typeof RouteError>;
    expect(re.statusCode).toBe(statusCode);
    if (code) expect(re.code).toBe(code);
    return re;
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSynthesizeResult = {
    audio: Buffer.from("fake-audio"),
    contentType: "audio/mpeg",
  };
  mockSynthesizeError = null;
  lastSynthesizeOptions = null;
});

afterEach(() => {
  // Reset mocks to defaults
});

// ---------------------------------------------------------------------------
// Tests — route inventory
// ---------------------------------------------------------------------------

describe("tts-routes", () => {
  test("exports route definitions for tts/providers, tts/synthesize, and tts/synthesize-cli", () => {
    expect(ROUTES).toHaveLength(3);

    const providers = getRoute("tts/providers");
    expect(providers.method).toBe("GET");
    expect(providers.policy?.requiredScopes).toContain("settings.read");

    const synthesize = getRoute("tts/synthesize");
    expect(synthesize.method).toBe("POST");
    expect(synthesize.policy?.requiredScopes).toContain("chat.read");

    const synthesizeCli = getRoute("tts/synthesize-cli");
    expect(synthesizeCli.method).toBe("POST");
    expect(synthesizeCli.policy?.requiredScopes).toContain("chat.read");
  });
});

// ---------------------------------------------------------------------------
// Tests — formatTtsFailureMessage
// ---------------------------------------------------------------------------

describe("formatTtsFailureMessage", () => {
  test("returns the base message when given a non-Error value", () => {
    expect(formatTtsFailureMessage(undefined)).toBe("TTS synthesis failed");
    expect(formatTtsFailureMessage(null)).toBe("TTS synthesis failed");
    expect(formatTtsFailureMessage("oops")).toBe("TTS synthesis failed");
  });

  test("returns the base message when the error has no message text", () => {
    const err = new Error("");
    expect(formatTtsFailureMessage(err)).toBe("TTS synthesis failed");
  });

  test("prefixes raw provider error messages with the base", () => {
    const err = new Error("Voice not found");
    expect(formatTtsFailureMessage(err)).toBe(
      "TTS synthesis failed: Voice not found",
    );
  });

  test("passes pre-prefixed messages through verbatim (no double-prefix)", () => {
    const err = new Error(
      "TTS synthesis failed (provider: elevenlabs): Free users cannot use library voices via the API.",
    );
    expect(formatTtsFailureMessage(err)).toBe(
      "TTS synthesis failed (provider: elevenlabs): Free users cannot use library voices via the API.",
    );
  });

  test("trims surrounding whitespace from messages", () => {
    const err = new Error("   Quota exceeded   ");
    expect(formatTtsFailureMessage(err)).toBe(
      "TTS synthesis failed: Quota exceeded",
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — tts/synthesize
// ---------------------------------------------------------------------------

describe("tts/synthesize", () => {
  test("throws 400 when text is missing", async () => {
    const { handler } = getRoute("tts/synthesize");
    await expectRouteError(
      () => handler(makeSynthesizeArgs({})),
      400,
      "BAD_REQUEST",
    );
  });

  test("throws 400 when text is not a string", async () => {
    const { handler } = getRoute("tts/synthesize");
    await expectRouteError(
      () => handler(makeSynthesizeArgs({ text: 42 })),
      400,
      "BAD_REQUEST",
    );
  });

  test("throws 400 when text is empty after sanitization", async () => {
    const { handler } = getRoute("tts/synthesize");
    const err = await expectRouteError(
      () => handler(makeSynthesizeArgs({ text: "   " })),
      400,
      "BAD_REQUEST",
    );
    expect(err.message).toContain("no speakable content");
  });

  test("returns Uint8Array with synthesized audio", async () => {
    const { handler } = getRoute("tts/synthesize");
    const result = await handler(makeSynthesizeArgs({ text: "Say this" }));

    expect(result).toBeInstanceOf(Uint8Array);
    expect(lastSynthesizeOptions).not.toBeNull();
    expect(lastSynthesizeOptions!.text).toBe("Say this");
    expect(lastSynthesizeOptions!.useCase).toBe("message-playback");
  });

  test("accepts optional context and conversationId", async () => {
    const { handler } = getRoute("tts/synthesize");
    const result = await handler(
      makeSynthesizeArgs({
        text: "Hello",
        context: "voice-mode",
        conversationId: "conv-789",
      }),
    );

    expect(result).toBeInstanceOf(Uint8Array);
  });

  test("throws 503 when TTS provider is not configured", async () => {
    mockSynthesizeError = new MockTtsSynthesisError(
      "TTS_PROVIDER_NOT_CONFIGURED",
      "TTS provider not configured",
    );

    const { handler } = getRoute("tts/synthesize");
    await expectRouteError(
      () => handler(makeSynthesizeArgs({ text: "Say this" })),
      503,
      "SERVICE_UNAVAILABLE",
    );
  });

  test("throws 502 when synthesis fails with generic error", async () => {
    mockSynthesizeError = new MockTtsSynthesisError(
      "TTS_SYNTHESIS_FAILED",
      "upstream failure",
    );

    const { handler } = getRoute("tts/synthesize");
    await expectRouteError(
      () => handler(makeSynthesizeArgs({ text: "Say this" })),
      502,
      "BAD_GATEWAY",
    );
  });

  test("propagates the underlying error message into the 502 response", async () => {
    // Mimics what `synthesize-text.ts` re-throws when an ElevenLabs adapter
    // raises ELEVENLABS_TTS_HTTP_ERROR with a parsed upstream message.
    mockSynthesizeError = new MockTtsSynthesisError(
      "TTS_SYNTHESIS_FAILED",
      "TTS synthesis failed (provider: elevenlabs): Free users cannot use library voices via the API. Please upgrade your subscription to use this voice.",
    );

    const { handler } = getRoute("tts/synthesize");
    const err = await expectRouteError(
      () => handler(makeSynthesizeArgs({ text: "Say this" })),
      502,
      "BAD_GATEWAY",
    );
    expect(err.message).toContain("Free users cannot use library voices");
    expect(err.message).toContain("Please upgrade your subscription");
    // No double-prefix — message stays as the inner self-describing form.
    expect(err.message.startsWith("TTS synthesis failed")).toBe(true);
    expect(
      err.message.startsWith("TTS synthesis failed: TTS synthesis failed"),
    ).toBe(false);
  });

  test("responseHeaders resolves Content-Type from config", () => {
    const route = getRoute("tts/synthesize");
    expect(route.responseHeaders).toBeDefined();
    const headers =
      typeof route.responseHeaders === "function"
        ? route.responseHeaders({ headers: {} })
        : route.responseHeaders!;
    expect(headers["Content-Type"]).toBe("audio/mpeg");
  });
});

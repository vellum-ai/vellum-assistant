import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — must appear before any imports of the modules under test
// ---------------------------------------------------------------------------

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// -- Feature flag mock -----------------------------------------------------

let mockFeatureFlagEnabled = true;

mock.module("../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => mockFeatureFlagEnabled,
}));

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

// -- Conversation history mock ---------------------------------------------

let mockMessageContent: { text?: string } | null = {
  text: "Hello, world!",
};

mock.module("../../../daemon/handlers/conversation-history.js", () => ({
  getMessageContent: () => mockMessageContent,
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
import { ROUTES } from "../tts-routes.js";
import type { RouteHandlerArgs } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRoute(endpoint: string) {
  const route = ROUTES.find((r) => r.endpoint === endpoint);
  if (!route) throw new Error(`Route ${endpoint} not found`);
  return route;
}

function makeMessageTtsArgs(
  overrides: { messageId?: string; conversationId?: string | null } = {},
): RouteHandlerArgs {
  const messageId = overrides.messageId ?? "msg-123";
  const conversationId = overrides.conversationId ?? "conv-456";
  return {
    pathParams: { messageId },
    queryParams: conversationId !== null ? { conversationId } : {},
    headers: {},
  };
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
  mockFeatureFlagEnabled = true;
  mockMessageContent = { text: "Hello, world!" };
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
// Tests — messages/:messageId/tts
// ---------------------------------------------------------------------------

describe("tts-routes", () => {
  test("exports route definitions for messages/:messageId/tts and tts/synthesize", () => {
    expect(ROUTES).toHaveLength(2);

    const msgTts = getRoute("messages/:messageId/tts");
    expect(msgTts.method).toBe("POST");
    expect(msgTts.policyKey).toBe("messages/tts");

    const synthesize = getRoute("tts/synthesize");
    expect(synthesize.method).toBe("POST");
    expect(synthesize.policyKey).toBe("tts/synthesize");
  });

  // -- Feature flag gating --------------------------------------------------

  test("throws 403 when message-tts flag is disabled", async () => {
    mockFeatureFlagEnabled = false;

    const { handler } = getRoute("messages/:messageId/tts");
    const err = await expectRouteError(
      () => handler(makeMessageTtsArgs()),
      403,
      "FORBIDDEN",
    );
    expect(err.message).toContain("not enabled");
  });

  // -- Message lookup -------------------------------------------------------

  test("throws 404 when message is not found", async () => {
    mockMessageContent = null;

    const { handler } = getRoute("messages/:messageId/tts");
    const err = await expectRouteError(
      () => handler(makeMessageTtsArgs({ messageId: "missing-id" })),
      404,
      "NOT_FOUND",
    );
    expect(err.message).toContain("missing-id");
  });

  test("throws 400 when message has no text content", async () => {
    mockMessageContent = { text: undefined };

    const { handler } = getRoute("messages/:messageId/tts");
    const err = await expectRouteError(
      () => handler(makeMessageTtsArgs()),
      400,
      "BAD_REQUEST",
    );
    expect(err.message).toContain("no text content");
  });

  test("throws 400 when sanitized text is empty", async () => {
    mockMessageContent = { text: "   " };

    const { handler } = getRoute("messages/:messageId/tts");
    const err = await expectRouteError(
      () => handler(makeMessageTtsArgs()),
      400,
      "BAD_REQUEST",
    );
    expect(err.message).toContain("no speakable text");
  });

  // -- Success path ---------------------------------------------------------

  test("returns Uint8Array with synthesized audio", async () => {
    const { handler } = getRoute("messages/:messageId/tts");
    const result = await handler(makeMessageTtsArgs());

    expect(result).toBeInstanceOf(Uint8Array);
    expect(lastSynthesizeOptions).not.toBeNull();
    expect(lastSynthesizeOptions!.text).toBe("Hello, world!");
    expect(lastSynthesizeOptions!.useCase).toBe("message-playback");
  });

  test("responseHeaders resolves Content-Type from config", () => {
    const route = getRoute("messages/:messageId/tts");
    expect(route.responseHeaders).toBeDefined();
    const headers =
      typeof route.responseHeaders === "function"
        ? route.responseHeaders({ headers: {} })
        : route.responseHeaders!;
    expect(headers["Content-Type"]).toBe("audio/mpeg");
  });

  // -- Provider not configured ----------------------------------------------

  test("throws 503 when TTS provider is not configured", async () => {
    mockSynthesizeError = new MockTtsSynthesisError(
      "TTS_PROVIDER_NOT_CONFIGURED",
      "TTS provider not configured",
    );

    const { handler } = getRoute("messages/:messageId/tts");
    const err = await expectRouteError(
      () => handler(makeMessageTtsArgs()),
      503,
      "SERVICE_UNAVAILABLE",
    );
    expect(err.message).toContain("not configured");
  });

  // -- Synthesis failure ----------------------------------------------------

  test("throws 502 when synthesis fails with generic error", async () => {
    mockSynthesizeError = new MockTtsSynthesisError(
      "TTS_SYNTHESIS_FAILED",
      "upstream failure",
    );

    const { handler } = getRoute("messages/:messageId/tts");
    await expectRouteError(
      () => handler(makeMessageTtsArgs()),
      502,
      "BAD_GATEWAY",
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
});

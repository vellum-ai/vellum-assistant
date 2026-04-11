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

mock.module("../../../tts/synthesize-text.js", () => ({
  synthesizeText: async (options: Record<string, unknown>) => {
    lastSynthesizeOptions = options;
    if (mockSynthesizeError) throw mockSynthesizeError;
    return mockSynthesizeResult;
  },
  TtsSynthesisError: class TtsSynthesisError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "TtsSynthesisError";
      this.code = code;
    }
  },
}));

// ---------------------------------------------------------------------------
// Import under test — after mocks
// ---------------------------------------------------------------------------

import type { RouteContext } from "../../http-router.js";
import { ttsRouteDefinitions } from "../tts-routes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getHandler() {
  const routes = ttsRouteDefinitions();
  return routes[0].handler;
}

function makeRouteContext(
  overrides: Partial<{
    messageId: string;
    conversationId: string | null;
  }> = {},
): RouteContext {
  const messageId = overrides.messageId ?? "msg-123";
  const conversationId = overrides.conversationId ?? "conv-456";

  const searchParams = new URLSearchParams();
  if (conversationId !== null) {
    searchParams.set("conversationId", conversationId);
  }
  const url = new URL(
    `http://localhost/v1/messages/${messageId}/tts?${searchParams.toString()}`,
  );

  return {
    req: new Request(url, { method: "POST" }),
    url,
    server: {} as RouteContext["server"],
    authContext: {
      subject: "test-user",
      principalType: "host",
      assistantId: "self",
      scopeProfile: "host",
      scopes: new Set(),
      policyEpoch: 0,
    },
    params: { id: messageId },
  } as RouteContext;
}

async function readErrorBody(
  response: Response,
): Promise<{ error: { code: string; message: string } }> {
  return response.json();
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
// Tests
// ---------------------------------------------------------------------------

describe("tts-routes", () => {
  // -- Route metadata -------------------------------------------------------

  test("exports a single route definition for messages/:id/tts", () => {
    const routes = ttsRouteDefinitions();
    expect(routes).toHaveLength(1);
    expect(routes[0].endpoint).toBe("messages/:id/tts");
    expect(routes[0].method).toBe("POST");
  });

  test("route description is provider-agnostic", () => {
    const routes = ttsRouteDefinitions();
    expect(routes[0].description).not.toMatch(/fish/i);
    expect(routes[0].description).toContain("configured TTS provider");
  });

  // -- Feature flag gating --------------------------------------------------

  test("returns 403 when message-tts flag is disabled", async () => {
    mockFeatureFlagEnabled = false;

    const handler = getHandler();
    const res = await handler(makeRouteContext());

    expect(res.status).toBe(403);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("not enabled");
  });

  // -- Message lookup -------------------------------------------------------

  test("returns 404 when message is not found", async () => {
    mockMessageContent = null;

    const handler = getHandler();
    const res = await handler(makeRouteContext({ messageId: "missing-id" }));

    expect(res.status).toBe(404);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("missing-id");
  });

  test("returns 400 when message has no text content", async () => {
    mockMessageContent = { text: undefined };

    const handler = getHandler();
    const res = await handler(makeRouteContext());

    expect(res.status).toBe(400);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("no text content");
  });

  test("returns 400 when sanitized text is empty", async () => {
    mockMessageContent = { text: "   " };

    const handler = getHandler();
    const res = await handler(makeRouteContext());

    expect(res.status).toBe(400);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("no speakable text");
  });

  // -- Provider selection via orchestration layer ---------------------------

  test("delegates to synthesizeText with message-playback use case", async () => {
    const handler = getHandler();
    const res = await handler(makeRouteContext());

    expect(res.status).toBe(200);
    expect(lastSynthesizeOptions).not.toBeNull();
    expect(lastSynthesizeOptions!.text).toBe("Hello, world!");
    expect(lastSynthesizeOptions!.useCase).toBe("message-playback");
  });

  test("returns audio response with correct content type", async () => {
    mockSynthesizeResult = {
      audio: Buffer.from("wav-audio"),
      contentType: "audio/wav",
    };

    const handler = getHandler();
    const res = await handler(makeRouteContext());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/wav");

    const body = await res.arrayBuffer();
    expect(Buffer.from(body).toString()).toBe("wav-audio");
  });

  // -- Provider not configured ----------------------------------------------

  test("returns 503 when TTS provider is not configured", async () => {
    const err = new Error("TTS provider not configured");
    Object.assign(err, { code: "TTS_PROVIDER_NOT_CONFIGURED" });
    mockSynthesizeError = err;

    const handler = getHandler();
    const res = await handler(makeRouteContext());

    expect(res.status).toBe(503);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(body.error.message).toContain("not configured");
  });

  // -- Synthesis failure ----------------------------------------------------

  test("returns 502 when synthesis fails with generic error", async () => {
    mockSynthesizeError = new Error("upstream failure");

    const handler = getHandler();
    const res = await handler(makeRouteContext());

    expect(res.status).toBe(502);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toContain("synthesis failed");
  });
});

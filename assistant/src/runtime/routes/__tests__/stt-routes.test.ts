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

// -- Transcriber mock -------------------------------------------------------

import type { BatchTranscriber } from "../../../stt/types.js";
import { SttError } from "../../../stt/types.js";

let mockTranscriber: BatchTranscriber | null = null;
let mockResolveError: Error | null = null;

mock.module("../../../providers/speech-to-text/resolve.js", () => ({
  resolveBatchTranscriber: async () => {
    if (mockResolveError) throw mockResolveError;
    return mockTranscriber;
  },
}));

// ---------------------------------------------------------------------------
// Import under test — after mocks
// ---------------------------------------------------------------------------

import type { RouteContext } from "../../http-router.js";
import { sttRouteDefinitions } from "../stt-routes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTranscribeHandler() {
  const routes = sttRouteDefinitions();
  return routes[0].handler;
}

function makeRouteContext(body: unknown): RouteContext {
  const url = new URL("http://localhost/v1/stt/transcribe");
  return {
    req: new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    url,
    server: {} as RouteContext["server"],
    authContext: {
      subject: "test-user",
      principalType: "local",
      assistantId: "self",
      scopeProfile: "local_v1",
      scopes: new Set(["local.all" as const]),
      policyEpoch: 0,
    },
    params: {},
  } as unknown as RouteContext;
}

function makeInvalidJsonContext(): RouteContext {
  const url = new URL("http://localhost/v1/stt/transcribe");
  return {
    req: new Request(url, {
      method: "POST",
      body: "not-json",
    }),
    url,
    server: {} as RouteContext["server"],
    authContext: {
      subject: "test-user",
      principalType: "local",
      assistantId: "self",
      scopeProfile: "local_v1",
      scopes: new Set(["local.all" as const]),
      policyEpoch: 0,
    },
    params: {},
  } as unknown as RouteContext;
}

async function readErrorBody(
  response: Response,
): Promise<{ error: { code: string; message: string } }> {
  return response.json();
}

/** Encode a string to base64 to simulate valid audio data. */
function toBase64(data: string): string {
  return Buffer.from(data).toString("base64");
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const fakeTranscriber: BatchTranscriber = {
  providerId: "openai-whisper",
  boundaryId: "daemon-batch",
  transcribe: async () => ({ text: "hello world" }),
};

beforeEach(() => {
  mockTranscriber = fakeTranscriber;
  mockResolveError = null;
});

afterEach(() => {
  // Reset to defaults
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("stt-routes", () => {
  // -- Route metadata -------------------------------------------------------

  test("exports a route definition for stt/transcribe", () => {
    const routes = sttRouteDefinitions();
    expect(routes).toHaveLength(1);
    expect(routes[0].endpoint).toBe("stt/transcribe");
    expect(routes[0].method).toBe("POST");
    expect(routes[0].policyKey).toBe("stt/transcribe");
  });

  // -- Success path ---------------------------------------------------------

  test("returns transcribed text with provider and boundary ids", async () => {
    const handler = getTranscribeHandler();
    const res = await handler(
      makeRouteContext({
        audioBase64: toBase64("fake-audio-data"),
        mimeType: "audio/wav",
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      text: string;
      providerId: string;
      boundaryId: string;
    };
    expect(body.text).toBe("hello world");
    expect(body.providerId).toBe("openai-whisper");
    expect(body.boundaryId).toBe("daemon-batch");
  });

  test("accepts optional source parameter", async () => {
    const handler = getTranscribeHandler();
    const res = await handler(
      makeRouteContext({
        audioBase64: toBase64("fake-audio-data"),
        mimeType: "audio/wav",
        source: "dictation",
      }),
    );

    expect(res.status).toBe(200);
  });

  // -- Malformed body -------------------------------------------------------

  test("returns 400 for invalid JSON body", async () => {
    const handler = getTranscribeHandler();
    const res = await handler(makeInvalidJsonContext());

    expect(res.status).toBe(400);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Invalid JSON");
  });

  test("returns 400 when audioBase64 is missing", async () => {
    const handler = getTranscribeHandler();
    const res = await handler(makeRouteContext({ mimeType: "audio/wav" }));

    expect(res.status).toBe(400);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("audioBase64");
  });

  test("returns 400 when audioBase64 is empty string", async () => {
    const handler = getTranscribeHandler();
    const res = await handler(
      makeRouteContext({ audioBase64: "", mimeType: "audio/wav" }),
    );

    expect(res.status).toBe(400);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("audioBase64");
  });

  test("returns 400 when mimeType is missing", async () => {
    const handler = getTranscribeHandler();
    const res = await handler(
      makeRouteContext({ audioBase64: toBase64("data") }),
    );

    expect(res.status).toBe(400);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("mimeType");
  });

  test("returns 400 when mimeType does not start with audio/", async () => {
    const handler = getTranscribeHandler();
    const res = await handler(
      makeRouteContext({
        audioBase64: toBase64("data"),
        mimeType: "text/plain",
      }),
    );

    expect(res.status).toBe(400);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("mimeType");
    expect(body.error.message).toContain("audio/");
  });

  // -- Empty audio after decode ---------------------------------------------

  test("returns 400 when decoded audio payload is empty", async () => {
    const handler = getTranscribeHandler();
    // An empty base64 string "" is caught by the non-empty check above.
    // Use a base64 that decodes to empty buffer — this is actually impossible
    // for valid base64. But we can test with a base64 of zero-length content
    // by using the base64 of an empty string.
    const res = await handler(
      makeRouteContext({
        audioBase64: Buffer.from("").toString("base64"), // ""
        mimeType: "audio/wav",
      }),
    );

    // The empty base64 "" is caught by the non-empty string check
    expect(res.status).toBe(400);
  });

  // -- Missing provider (503) -----------------------------------------------

  test("returns 503 when no STT provider is configured", async () => {
    mockTranscriber = null;

    const handler = getTranscribeHandler();
    const res = await handler(
      makeRouteContext({
        audioBase64: toBase64("audio-data"),
        mimeType: "audio/wav",
      }),
    );

    expect(res.status).toBe(503);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(body.error.message).toContain("configured");
  });

  test("returns 503 when transcriber resolution throws", async () => {
    mockResolveError = new Error("credential store unavailable");

    const handler = getTranscribeHandler();
    const res = await handler(
      makeRouteContext({
        audioBase64: toBase64("audio-data"),
        mimeType: "audio/wav",
      }),
    );

    expect(res.status).toBe(503);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(body.error.message).toContain("not available");
  });

  // -- Timeout --------------------------------------------------------------

  test("returns 504 when transcription times out", async () => {
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async (_request) => {
        // Simulate timeout by checking if abort signal fires
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      },
    };

    const handler = getTranscribeHandler();
    const res = await handler(
      makeRouteContext({
        audioBase64: toBase64("audio-data"),
        mimeType: "audio/wav",
      }),
    );

    expect(res.status).toBe(504);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toContain("timed out");
  });

  // -- Provider failure (various categories) --------------------------------

  test("returns 401 for auth errors from provider", async () => {
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => {
        throw new SttError("auth", "Invalid API key (401)");
      },
    };

    const handler = getTranscribeHandler();
    const res = await handler(
      makeRouteContext({
        audioBase64: toBase64("audio-data"),
        mimeType: "audio/wav",
      }),
    );

    expect(res.status).toBe(401);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toContain("credentials");
  });

  test("returns 429 for rate-limit errors from provider", async () => {
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => {
        throw new SttError("rate-limit", "Rate limited (429)");
      },
    };

    const handler = getTranscribeHandler();
    const res = await handler(
      makeRouteContext({
        audioBase64: toBase64("audio-data"),
        mimeType: "audio/wav",
      }),
    );

    expect(res.status).toBe(429);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.message).toContain("rate limit");
  });

  test("returns 400 for invalid-audio errors from provider", async () => {
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => {
        throw new SttError("invalid-audio", "Unsupported audio format (400)");
      },
    };

    const handler = getTranscribeHandler();
    const res = await handler(
      makeRouteContext({
        audioBase64: toBase64("audio-data"),
        mimeType: "audio/wav",
      }),
    );

    expect(res.status).toBe(400);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("rejected");
  });

  test("returns 502 for generic provider errors", async () => {
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => {
        throw new Error("upstream kaboom");
      },
    };

    const handler = getTranscribeHandler();
    const res = await handler(
      makeRouteContext({
        audioBase64: toBase64("audio-data"),
        mimeType: "audio/wav",
      }),
    );

    expect(res.status).toBe(502);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toContain("provider error");
  });
});

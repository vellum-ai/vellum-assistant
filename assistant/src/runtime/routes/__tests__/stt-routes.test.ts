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

import { RouteError } from "../errors.js";
import { ROUTES } from "../stt-routes.js";
import type { RouteHandlerArgs } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRoute(endpoint: string) {
  const route = ROUTES.find((r) => r.endpoint === endpoint);
  if (!route) throw new Error(`Route ${endpoint} not found`);
  return route;
}

function makeArgs(body: unknown): RouteHandlerArgs {
  return {
    body: body as Record<string, unknown>,
    headers: {},
  };
}

/** Encode a string to base64 to simulate valid audio data. */
function toBase64(data: string): string {
  return Buffer.from(data).toString("base64");
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

  test("exports route definitions for stt/providers and stt/transcribe", () => {
    expect(ROUTES).toHaveLength(2);

    const providers = getRoute("stt/providers");
    expect(providers.method).toBe("GET");
    expect(providers.policyKey).toBe("stt/providers");

    const transcribe = getRoute("stt/transcribe");
    expect(transcribe.method).toBe("POST");
    expect(transcribe.policyKey).toBe("stt/transcribe");
  });

  // -- Success path ---------------------------------------------------------

  test("returns transcribed text with provider and boundary ids", async () => {
    const { handler } = getRoute("stt/transcribe");
    const result = (await handler(
      makeArgs({
        audioBase64: toBase64("fake-audio-data"),
        mimeType: "audio/wav",
      }),
    )) as { text: string; providerId: string; boundaryId: string };

    expect(result.text).toBe("hello world");
    expect(result.providerId).toBe("openai-whisper");
    expect(result.boundaryId).toBe("daemon-batch");
  });

  test("accepts optional source parameter", async () => {
    const { handler } = getRoute("stt/transcribe");
    const result = await handler(
      makeArgs({
        audioBase64: toBase64("fake-audio-data"),
        mimeType: "audio/wav",
        source: "dictation",
      }),
    );

    expect(result).toBeDefined();
  });

  // -- Malformed body -------------------------------------------------------

  test("throws 400 when audioBase64 is missing", async () => {
    const { handler } = getRoute("stt/transcribe");
    const err = await expectRouteError(
      () => handler(makeArgs({ mimeType: "audio/wav" })),
      400,
      "BAD_REQUEST",
    );
    expect(err.message).toContain("audioBase64");
  });

  test("throws 400 when audioBase64 is empty string", async () => {
    const { handler } = getRoute("stt/transcribe");
    await expectRouteError(
      () => handler(makeArgs({ audioBase64: "", mimeType: "audio/wav" })),
      400,
      "BAD_REQUEST",
    );
  });

  test("throws 400 when mimeType is missing", async () => {
    const { handler } = getRoute("stt/transcribe");
    const err = await expectRouteError(
      () => handler(makeArgs({ audioBase64: toBase64("data") })),
      400,
      "BAD_REQUEST",
    );
    expect(err.message).toContain("mimeType");
  });

  test("throws 400 when mimeType does not start with audio/", async () => {
    const { handler } = getRoute("stt/transcribe");
    const err = await expectRouteError(
      () =>
        handler(
          makeArgs({ audioBase64: toBase64("data"), mimeType: "text/plain" }),
        ),
      400,
      "BAD_REQUEST",
    );
    expect(err.message).toContain("mimeType");
    expect(err.message).toContain("audio/");
  });

  // -- Empty audio after decode ---------------------------------------------

  test("throws 400 when decoded audio payload is empty", async () => {
    const { handler } = getRoute("stt/transcribe");
    await expectRouteError(
      () =>
        handler(
          makeArgs({
            audioBase64: Buffer.from("").toString("base64"),
            mimeType: "audio/wav",
          }),
        ),
      400,
    );
  });

  // -- Missing provider (503) -----------------------------------------------

  test("throws 503 when no STT provider is configured", async () => {
    mockTranscriber = null;

    const { handler } = getRoute("stt/transcribe");
    const err = await expectRouteError(
      () =>
        handler(
          makeArgs({
            audioBase64: toBase64("audio-data"),
            mimeType: "audio/wav",
          }),
        ),
      503,
      "SERVICE_UNAVAILABLE",
    );
    expect(err.message).toContain("configured");
  });

  test("throws 503 when transcriber resolution throws", async () => {
    mockResolveError = new Error("credential store unavailable");

    const { handler } = getRoute("stt/transcribe");
    const err = await expectRouteError(
      () =>
        handler(
          makeArgs({
            audioBase64: toBase64("audio-data"),
            mimeType: "audio/wav",
          }),
        ),
      503,
      "SERVICE_UNAVAILABLE",
    );
    expect(err.message).toContain("not available");
  });

  // -- Timeout --------------------------------------------------------------

  test("throws 504 when transcription times out", async () => {
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      },
    };

    const { handler } = getRoute("stt/transcribe");
    await expectRouteError(
      () =>
        handler(
          makeArgs({
            audioBase64: toBase64("audio-data"),
            mimeType: "audio/wav",
          }),
        ),
      504,
      "GATEWAY_TIMEOUT",
    );
  });

  // -- Provider failure (various categories) --------------------------------

  test("throws 401 for auth errors from provider", async () => {
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => {
        throw new SttError("auth", "Invalid API key (401)");
      },
    };

    const { handler } = getRoute("stt/transcribe");
    const err = await expectRouteError(
      () =>
        handler(
          makeArgs({
            audioBase64: toBase64("audio-data"),
            mimeType: "audio/wav",
          }),
        ),
      401,
      "UNAUTHORIZED",
    );
    expect(err.message).toContain("credentials");
  });

  test("throws 429 for rate-limit errors from provider", async () => {
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => {
        throw new SttError("rate-limit", "Rate limited (429)");
      },
    };

    const { handler } = getRoute("stt/transcribe");
    const err = await expectRouteError(
      () =>
        handler(
          makeArgs({
            audioBase64: toBase64("audio-data"),
            mimeType: "audio/wav",
          }),
        ),
      429,
      "RATE_LIMITED",
    );
    expect(err.message).toContain("rate limit");
  });

  test("throws 400 for invalid-audio errors from provider", async () => {
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => {
        throw new SttError("invalid-audio", "Unsupported audio format (400)");
      },
    };

    const { handler } = getRoute("stt/transcribe");
    const err = await expectRouteError(
      () =>
        handler(
          makeArgs({
            audioBase64: toBase64("audio-data"),
            mimeType: "audio/wav",
          }),
        ),
      400,
      "BAD_REQUEST",
    );
    expect(err.message).toContain("rejected");
  });

  test("throws 502 for generic provider errors", async () => {
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => {
        throw new Error("upstream kaboom");
      },
    };

    const { handler } = getRoute("stt/transcribe");
    await expectRouteError(
      () =>
        handler(
          makeArgs({
            audioBase64: toBase64("audio-data"),
            mimeType: "audio/wav",
          }),
        ),
      502,
      "BAD_GATEWAY",
    );
  });
});

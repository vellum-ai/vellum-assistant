import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// -- Spawn mock (ffmpeg/ffprobe) for the file-transcription path ------------

type SpawnResult = { exitCode: number; stdout: string; stderr: string };
let spawnOverride: ((args: string[]) => SpawnResult) | null = null;

/**
 * Default spawn behavior: ffmpeg writes the requested output file so the
 * downstream readFile succeeds, ffprobe reports a short duration.
 */
function defaultSpawn(args: string[]): SpawnResult {
  if (args[0] === "ffmpeg") {
    const outputPath = args[args.length - 1];
    writeFileSync(outputPath, Buffer.from("fake-wav-bytes"));
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  if (args[0] === "ffprobe") {
    return { exitCode: 0, stdout: "1.0", stderr: "" };
  }
  return { exitCode: 0, stdout: "", stderr: "" };
}

mock.module("../../../util/spawn.js", () => ({
  FFMPEG_TRANSCODE_TIMEOUT_MS: 60_000,
  FFPROBE_TIMEOUT_MS: 10_000,
  STT_REQUEST_TIMEOUT_MS: 300_000,
  spawnWithTimeout: async (args: string[]) =>
    (spawnOverride ?? defaultSpawn)(args),
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
  spawnOverride = null;
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
    expect(ROUTES).toHaveLength(3);

    const providers = getRoute("stt/providers");
    expect(providers.method).toBe("GET");
    expect(providers.policy?.requiredScopes).toContain("settings.read");

    const transcribe = getRoute("stt/transcribe");
    expect(transcribe.method).toBe("POST");
    expect(transcribe.policy?.requiredScopes).toContain("chat.write");

    const transcribeFile = getRoute("stt/transcribe-file");
    expect(transcribeFile.method).toBe("POST");
    expect(transcribeFile.policy?.requiredScopes).toContain("chat.write");
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

  // -- File transcription: provider error categorization --------------------

  async function withTempAudioFile(
    run: (filePath: string) => Promise<void>,
  ): Promise<void> {
    const filePath = join(tmpdir(), `vellum-stt-test-${randomUUID()}.wav`);
    await writeFile(filePath, Buffer.from("fake-audio"));
    try {
      await run(filePath);
    } finally {
      await unlink(filePath).catch(() => {});
    }
  }

  test("transcribe-file maps provider auth failures (403) to 401", async () => {
    // Reproduces JARVIS-994: a raw Gemini 403 denial must surface as an
    // actionable 401, not a generic 502, and must not be treated as a
    // daemon-level error.
    mockTranscriber = {
      providerId: "google-gemini",
      boundaryId: "daemon-batch",
      transcribe: async () => {
        throw new Error(
          'Google Gemini API error (403): {"error":{"code":403,"message":"Your project has been denied access. Please contact support.","status":"PERMISSION_DENIED"}}',
        );
      },
    };

    await withTempAudioFile(async (filePath) => {
      const { handler } = getRoute("stt/transcribe-file");
      const err = await expectRouteError(
        () => handler(makeArgs({ filePath })),
        401,
        "UNAUTHORIZED",
      );
      expect(err.message).toContain("credentials");
    });
  });

  test("transcribe-file maps generic provider failures to 502", async () => {
    mockTranscriber = {
      providerId: "openai-whisper",
      boundaryId: "daemon-batch",
      transcribe: async () => {
        throw new Error("upstream kaboom");
      },
    };

    await withTempAudioFile(async (filePath) => {
      const { handler } = getRoute("stt/transcribe-file");
      await expectRouteError(
        () => handler(makeArgs({ filePath })),
        502,
        "BAD_GATEWAY",
      );
    });
  });

  test("transcribe-file maps ffmpeg failures to 502 even when stderr contains a status-like number", async () => {
    // Guards against ffmpeg stderr (or a user-supplied path) deciding the HTTP
    // category: a conversion failure whose message contains "403" must stay a
    // 502 conversion error, not become a misleading 401 auth error.
    spawnOverride = (args) =>
      args[0] === "ffmpeg"
        ? { exitCode: 1, stdout: "", stderr: "Error opening /tmp/403/clip.wav" }
        : { exitCode: 0, stdout: "1.0", stderr: "" };

    await withTempAudioFile(async (filePath) => {
      const { handler } = getRoute("stt/transcribe-file");
      await expectRouteError(
        () => handler(makeArgs({ filePath })),
        502,
        "BAD_GATEWAY",
      );
    });
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state — mutable variables control per-test behavior
// ---------------------------------------------------------------------------

let mockStrategy: string = "local_only";
let mockGeminiKey: string | undefined = "test-gemini-key";
let mockApiKey: string | undefined = "test-api-key-123";
let mockBaseUrl = "https://platform.test.vellum.ai";
let mockPlatformEnvUrl = "https://env.test.vellum.ai";
let mockWorkspaceDir = "/tmp/test-workspace-e2e";

const mkdirSyncFn = mock(() => {});
const writeFileSyncFn = mock(() => {});
const renameSyncFn = mock(() => {});

let logInfoCalls: Array<[unknown, string]> = [];
let logWarnCalls: Array<[unknown, string]> = [];
let logErrorCalls: Array<[unknown, string]> = [];

// ---------------------------------------------------------------------------
// Gemini mock state
// ---------------------------------------------------------------------------

let geminiGenerateContentResult: unknown;
const geminiGenerateContentFn = mock(async () => geminiGenerateContentResult);

// ---------------------------------------------------------------------------
// Mock modules — must be before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    apiKeys: { gemini: mockGeminiKey },
    avatar: { generationStrategy: mockStrategy },
    platform: { baseUrl: mockBaseUrl },
    imageGenModel: "gemini-2.5-flash-image",
  }),
}));

mock.module("../config/env.js", () => ({
  getPlatformBaseUrl: () => mockPlatformEnvUrl,
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (account: string) => {
    if (account === "credential:vellum:assistant_api_key") return mockApiKey;
    return undefined;
  },
}));

mock.module("../util/platform.js", () => ({
  getWorkspaceDir: () => mockWorkspaceDir,
}));

mock.module("pino", () => {
  function createLogger() {
    return {
      child: () => createLogger(),
      debug: () => {},
      info: (...args: unknown[]) => {
        logInfoCalls.push(args as [unknown, string]);
      },
      warn: (...args: unknown[]) => {
        logWarnCalls.push(args as [unknown, string]);
      },
      error: (...args: unknown[]) => {
        logErrorCalls.push(args as [unknown, string]);
      },
    };
  }

  const pino = Object.assign(() => createLogger(), {
    destination: () => ({ write: () => true }),
    multistream: () => ({ write: () => true }),
  });

  return {
    default: pino,
  };
});

mock.module("pino-pretty", () => ({
  default: () => ({ write: () => true }),
}));

mock.module("node:fs", () => ({
  mkdirSync: mkdirSyncFn,
  writeFileSync: writeFileSyncFn,
  renameSync: renameSyncFn,
}));

mock.module("node:crypto", () => ({
  randomUUID: () => "00000000-0000-0000-0000-000000000000",
}));

mock.module("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: geminiGenerateContentFn,
    };
  },
  ApiError: class extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

// Import after all mocks are set up
import { AVATAR_MAX_DECODED_BYTES } from "../media/avatar-types.js";
import { setAvatarTool } from "../tools/system/avatar-generator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function executeAvatar(description: string) {
  return setAvatarTool.execute(
    { description },
    {} as Parameters<typeof setAvatarTool.execute>[1],
  );
}

/** Standard successful managed avatar platform response. */
function managedPlatformResponse() {
  return {
    image: {
      mime_type: "image/png",
      data_base64: "iVBORw0KGgoAAAANSUhEUg==",
      bytes: 1024,
      sha256: "abc123",
    },
    usage: { billable: true, class_name: "assistant_avatar_system" },
    generation_source: "vertex",
    profile: "avatar_v1",
    correlation_id: "managed-corr-id-123",
  };
}

/** Standard successful Gemini generateContent response. */
function geminiContentResponse() {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              inlineData: {
                mimeType: "image/png",
                data: "iVBORw0KGgoAAAANSUhEUg==",
              },
            },
          ],
        },
      },
    ],
  };
}

function mockFetchReturning(response: {
  ok: boolean;
  status: number;
  body: unknown;
}) {
  globalThis.fetch = mock(() =>
    Promise.resolve({
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
    }),
  ) as unknown as typeof globalThis.fetch;
}

const originalFetch = globalThis.fetch;

const expectedAvatarPath =
  "/tmp/test-workspace-e2e/data/avatar/custom-avatar.png";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("avatar E2E integration", () => {
  // Save original GEMINI_API_KEY to restore after each test
  const originalGeminiKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    mockStrategy = "local_only";
    mockGeminiKey = "test-gemini-key";
    mockApiKey = "test-api-key-123";
    mockBaseUrl = "https://platform.test.vellum.ai";
    mockPlatformEnvUrl = "https://env.test.vellum.ai";
    mockWorkspaceDir = "/tmp/test-workspace-e2e";

    mkdirSyncFn.mockClear();
    writeFileSyncFn.mockClear();
    renameSyncFn.mockClear();
    geminiGenerateContentFn.mockClear();

    logInfoCalls = [];
    logWarnCalls = [];
    logErrorCalls = [];

    geminiGenerateContentResult = geminiContentResponse();
    globalThis.fetch = originalFetch;

    // Clear env var so tests control the key entirely via config mock
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    // Restore original GEMINI_API_KEY
    if (originalGeminiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalGeminiKey;
    }
  });

  // -----------------------------------------------------------------------
  // 1. Managed success E2E
  // -----------------------------------------------------------------------

  test("managed_required success — file written, correct content, success message", async () => {
    mockStrategy = "managed_required";
    mockFetchReturning({
      ok: true,
      status: 200,
      body: managedPlatformResponse(),
    });

    const result = await executeAvatar("a friendly robot");

    // Verify success message
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Avatar updated");

    // Verify file was written
    expect(mkdirSyncFn).toHaveBeenCalledTimes(1);
    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    expect(renameSyncFn).toHaveBeenCalledTimes(1);

    // Verify rename target is the expected avatar path
    expect((renameSyncFn.mock.calls[0] as unknown[])[1]).toBe(
      expectedAvatarPath,
    );

    // Verify the written buffer content matches the base64 data
    const writtenBuffer = (
      writeFileSyncFn.mock.calls[0] as unknown[]
    )[1] as Buffer;
    const expectedBuffer = Buffer.from("iVBORw0KGgoAAAANSUhEUg==", "base64");
    expect(writtenBuffer.equals(expectedBuffer)).toBe(true);

    // Verify Gemini was never called
    expect(geminiGenerateContentFn).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 2. Managed-required failure E2E — no fallback
  // -----------------------------------------------------------------------

  test("managed_required failure — error surfaced, no file written, no fallback", async () => {
    mockStrategy = "managed_required";
    mockFetchReturning({
      ok: false,
      status: 500,
      body: {
        code: "internal_error",
        subcode: "server_fault",
        detail: "Internal server error",
        retryable: true,
        correlation_id: "corr-500",
      },
    });

    const result = await executeAvatar("a friendly robot");

    // Verify error is surfaced
    expect(result.isError).toBe(true);
    expect(result.content).toContain("failed");

    // Verify no file was written
    expect(writeFileSyncFn).not.toHaveBeenCalled();
    expect(renameSyncFn).not.toHaveBeenCalled();

    // Verify Gemini was never called (no fallback)
    expect(geminiGenerateContentFn).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 3. Managed-prefer fallback E2E
  // -----------------------------------------------------------------------

  test("managed_prefer fallback — managed fails, local Gemini used, file written", async () => {
    mockStrategy = "managed_prefer";
    mockFetchReturning({
      ok: false,
      status: 502,
      body: {
        code: "upstream_error",
        subcode: "bad_gateway",
        detail: "Bad gateway",
        retryable: true,
        correlation_id: "corr-502",
      },
    });

    const result = await executeAvatar("a cute cat");

    // Verify success — local path was used
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Avatar updated");

    // Verify file was written
    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    expect(renameSyncFn).toHaveBeenCalledTimes(1);

    // Verify Gemini was called as fallback
    expect(geminiGenerateContentFn).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // 4. Managed-prefer no-fallback when managed unavailable (no API key)
  // -----------------------------------------------------------------------

  test("managed_prefer without API key — goes straight to local Gemini", async () => {
    mockStrategy = "managed_prefer";
    mockApiKey = undefined; // No managed API key available

    const result = await executeAvatar("a cute cat");

    // Verify success via local path
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Avatar updated");

    // Verify Gemini was called directly (no managed attempt)
    expect(geminiGenerateContentFn).toHaveBeenCalledTimes(1);

    // Verify file was written
    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    expect(renameSyncFn).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // 5. Local-only E2E
  // -----------------------------------------------------------------------

  test("local_only — only local Gemini called, managed never contacted", async () => {
    mockStrategy = "local_only";
    const fetchMock = mock(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await executeAvatar("a whimsical owl");

    // Verify success
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Avatar updated");

    // Verify Gemini was called
    expect(geminiGenerateContentFn).toHaveBeenCalledTimes(1);

    // Verify managed endpoint was never contacted
    expect(fetchMock).not.toHaveBeenCalled();

    // Verify file was written
    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    expect(renameSyncFn).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // 6. Response validation — bad MIME type
  // -----------------------------------------------------------------------

  test("managed response with disallowed MIME type — rejected, no file written", async () => {
    mockStrategy = "managed_required";
    const badResponse = managedPlatformResponse();
    badResponse.image.mime_type = "image/gif";
    mockFetchReturning({ ok: true, status: 200, body: badResponse });

    const result = await executeAvatar("a cat");

    // Verify error returned
    expect(result.isError).toBe(true);
    expect(result.content).toContain("failed");

    // Verify no file was written
    expect(writeFileSyncFn).not.toHaveBeenCalled();
    expect(renameSyncFn).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 7. Response validation — oversized image
  // -----------------------------------------------------------------------

  test("managed response with oversized data — rejected, no file written", async () => {
    mockStrategy = "managed_required";
    const oversizedResponse = managedPlatformResponse();
    oversizedResponse.image.bytes = AVATAR_MAX_DECODED_BYTES + 1;
    mockFetchReturning({ ok: true, status: 200, body: oversizedResponse });

    const result = await executeAvatar("a cat");

    // Verify error returned
    expect(result.isError).toBe(true);
    expect(result.content).toContain("failed");

    // Verify no file was written
    expect(writeFileSyncFn).not.toHaveBeenCalled();
    expect(renameSyncFn).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 8. Rate limit user message
  // -----------------------------------------------------------------------

  test("managed 429 response — user-friendly rate limit message", async () => {
    mockStrategy = "managed_required";
    mockFetchReturning({
      ok: false,
      status: 429,
      body: {
        code: "avatar_rate_limited",
        subcode: "too_many_requests",
        detail: "Rate limit exceeded",
        retryable: true,
        correlation_id: "corr-429",
      },
    });

    const result = await executeAvatar("a cat");

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("rate limited");
  });

  // -----------------------------------------------------------------------
  // 9. Correlation ID propagation
  // -----------------------------------------------------------------------

  test("managed success — correlation ID from response is propagated through the pipeline", async () => {
    mockStrategy = "managed_required";
    const response = managedPlatformResponse();
    response.correlation_id = "unique-corr-id-xyz";
    mockFetchReturning({ ok: true, status: 200, body: response });

    const result = await executeAvatar("a robot");

    // The managed path succeeded and wrote the avatar file
    expect(result.isError).toBe(false);
    expect(writeFileSyncFn).toHaveBeenCalled();

    const correlationLogged = logInfoCalls.some(([meta, message]) => {
      if (message !== "Avatar saved successfully") return false;
      if (!meta || typeof meta !== "object" || !("correlationId" in meta)) {
        return false;
      }
      return (
        (meta as { correlationId?: unknown }).correlationId ===
        "unique-corr-id-xyz"
      );
    });

    expect(correlationLogged).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state — mutable variables control per-test behavior
// ---------------------------------------------------------------------------

let mockGeminiKey: string | undefined = "test-gemini-key";
let mockWorkspaceDir = "/tmp/test-workspace-e2e";

const mkdirSyncFn = mock(() => {});
const writeFileSyncFn = mock(() => {});
const renameSyncFn = mock(() => {});

let logInfoCalls: Array<[unknown, string]> = [];
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
    imageGenModel: "gemini-2.5-flash-image",
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-2.5-flash-image",
      },
      "web-search": { mode: "your-own", provider: "anthropic-native" },
    },
  }),
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (name: string) =>
    name === "gemini" ? mockGeminiKey : null,
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
      warn: () => {},
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
import { generateAndSaveAvatar } from "../tools/system/avatar-generator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function executeAvatar(description: string) {
  return generateAndSaveAvatar(description);
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

const expectedAvatarPath =
  "/tmp/test-workspace-e2e/data/avatar/avatar-image.png";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("avatar E2E integration", () => {
  // Save original GEMINI_API_KEY to restore after each test
  const originalGeminiKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    mockGeminiKey = "test-gemini-key";
    mockWorkspaceDir = "/tmp/test-workspace-e2e";

    mkdirSyncFn.mockClear();
    writeFileSyncFn.mockClear();
    renameSyncFn.mockClear();
    geminiGenerateContentFn.mockClear();

    logInfoCalls = [];
    logErrorCalls = [];

    geminiGenerateContentResult = geminiContentResponse();

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
  // 1. Local Gemini success
  // -----------------------------------------------------------------------

  test("local Gemini success — file written, correct content, success message", async () => {
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

    // Verify Gemini was called
    expect(geminiGenerateContentFn).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // 2. No Gemini key — error
  // -----------------------------------------------------------------------

  test("no Gemini key — error surfaced", async () => {
    mockGeminiKey = undefined;

    const result = await executeAvatar("a whimsical owl");

    expect(result.isError).toBe(true);
    expect(result.content).toContain("failed");
  });

  // -----------------------------------------------------------------------
  // 3. Gemini API failure
  // -----------------------------------------------------------------------

  test("Gemini API failure — error surfaced", async () => {
    geminiGenerateContentResult = {
      candidates: [
        {
          content: {
            parts: [],
          },
        },
      ],
    };

    const result = await executeAvatar("a cat");

    expect(result.isError).toBe(true);
    expect(result.content).toContain("failed");
  });
});

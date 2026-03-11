import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockStrategy: string | undefined;
let mockGeminiKey: string | undefined = "test-gemini-key";
let mockManagedAvailable = true;
let mockManagedResult: unknown;
let mockManagedError: Error | undefined;
let mockGeminiResult: unknown;

const generateManagedAvatarFn = mock(async () => {
  if (mockManagedError) throw mockManagedError;
  return mockManagedResult;
});

const generateImageFn = mock(async () => mockGeminiResult);

const isManagedAvailableFn = mock(() => mockManagedAvailable);

// ---------------------------------------------------------------------------
// Mock modules — before importing module under test
// ---------------------------------------------------------------------------

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    apiKeys: { gemini: mockGeminiKey },
    avatar: { generationStrategy: mockStrategy ?? "local_only" },
  }),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

mock.module("../media/managed-avatar-client.js", () => ({
  isManagedAvailable: isManagedAvailableFn,
  generateManagedAvatar: generateManagedAvatarFn,
}));

mock.module("../media/gemini-image-service.js", () => ({
  generateImage: generateImageFn,
}));

// Import after mocking
import {
  getAvatarStrategy,
  routedGenerateAvatar,
} from "../media/avatar-router.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function managedResponse() {
  return {
    image: {
      mime_type: "image/png",
      data_base64: "base64data",
      bytes: 1024,
      sha256: "abc",
    },
    correlation_id: "test-correlation-id",
  };
}

function geminiResponse() {
  return {
    images: [{ mimeType: "image/png", dataBase64: "base64data" }],
    resolvedModel: "gemini-2.5-flash-image",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("avatar-router", () => {
  beforeEach(() => {
    mockStrategy = undefined;
    mockGeminiKey = "test-gemini-key";
    mockManagedAvailable = true;
    mockManagedResult = managedResponse();
    mockManagedError = undefined;
    mockGeminiResult = geminiResponse();
    generateManagedAvatarFn.mockClear();
    generateImageFn.mockClear();
    isManagedAvailableFn.mockClear();
  });

  // 1. managed_required — managed success
  test("managed_required returns pathUsed managed on success", async () => {
    mockStrategy = "managed_required";
    const result = await routedGenerateAvatar("a cute cat");
    expect(result.pathUsed).toBe("managed");
    expect(result.imageBase64).toBe("base64data");
    expect(result.mimeType).toBe("image/png");
    expect(generateManagedAvatarFn).toHaveBeenCalledTimes(1);
    expect(generateImageFn).not.toHaveBeenCalled();
  });

  // 2. managed_required — managed failure throws, no fallback
  test("managed_required throws on managed failure without fallback", async () => {
    mockStrategy = "managed_required";
    mockManagedError = new Error("upstream error");
    await expect(routedGenerateAvatar("a cute cat")).rejects.toThrow(
      "upstream error",
    );
    expect(generateImageFn).not.toHaveBeenCalled();
  });

  // 3. local_only — calls local Gemini, never managed
  test("local_only calls local Gemini and never managed", async () => {
    mockStrategy = "local_only";
    const result = await routedGenerateAvatar("a cute cat");
    expect(result.pathUsed).toBe("local");
    expect(result.imageBase64).toBe("base64data");
    expect(generateImageFn).toHaveBeenCalledTimes(1);
    expect(generateManagedAvatarFn).not.toHaveBeenCalled();
  });

  // 4. local_only — missing Gemini API key throws
  test("local_only throws when Gemini API key is missing", async () => {
    mockStrategy = "local_only";
    mockGeminiKey = undefined;
    // Also clear the env var to ensure no fallback
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      await expect(routedGenerateAvatar("a cute cat")).rejects.toThrow(
        "Gemini API key is not configured",
      );
      expect(generateImageFn).not.toHaveBeenCalled();
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });

  // 5. managed_prefer — managed success
  test("managed_prefer returns pathUsed managed on success", async () => {
    mockStrategy = "managed_prefer";
    const result = await routedGenerateAvatar("a cute cat");
    expect(result.pathUsed).toBe("managed");
    expect(generateManagedAvatarFn).toHaveBeenCalledTimes(1);
    expect(generateImageFn).not.toHaveBeenCalled();
  });

  // 6. managed_prefer — managed failure falls back to local
  test("managed_prefer falls back to local on managed failure", async () => {
    mockStrategy = "managed_prefer";
    mockManagedError = new Error("managed failed");
    const result = await routedGenerateAvatar("a cute cat");
    expect(result.pathUsed).toBe("local");
    expect(generateManagedAvatarFn).toHaveBeenCalledTimes(1);
    expect(generateImageFn).toHaveBeenCalledTimes(1);
  });

  // 7. managed_prefer — managed unavailable goes directly to local
  test("managed_prefer goes to local when managed unavailable", async () => {
    mockStrategy = "managed_prefer";
    mockManagedAvailable = false;
    const result = await routedGenerateAvatar("a cute cat");
    expect(result.pathUsed).toBe("local");
    expect(generateManagedAvatarFn).not.toHaveBeenCalled();
    expect(generateImageFn).toHaveBeenCalledTimes(1);
  });

  // 8. Default strategy is local_only when config key absent
  test("defaults to local_only when config key is absent", () => {
    mockStrategy = undefined;
    expect(getAvatarStrategy()).toBe("local_only");
  });

  // 10. managed_required passes model to generateManagedAvatar
  test("managed_required forwards model to generateManagedAvatar", async () => {
    mockStrategy = "managed_required";
    const result = await routedGenerateAvatar("a cute cat", {
      model: "imagen-3.0-generate-002",
    });
    expect(generateManagedAvatarFn).toHaveBeenCalledTimes(1);
    expect(generateManagedAvatarFn).toHaveBeenCalledWith("a cute cat", {
      correlationId: undefined,
      model: "imagen-3.0-generate-002",
    });
    expect(result.model).toBe("imagen-3.0-generate-002");
    expect(result.pathUsed).toBe("managed");
  });

  // 11. managed_prefer passes model to generateManagedAvatar on success
  test("managed_prefer forwards model to generateManagedAvatar on success", async () => {
    mockStrategy = "managed_prefer";
    const result = await routedGenerateAvatar("a cute cat", {
      model: "imagen-3.0-generate-002",
    });
    expect(generateManagedAvatarFn).toHaveBeenCalledTimes(1);
    expect(generateManagedAvatarFn).toHaveBeenCalledWith("a cute cat", {
      correlationId: undefined,
      model: "imagen-3.0-generate-002",
    });
    expect(result.model).toBe("imagen-3.0-generate-002");
    expect(result.pathUsed).toBe("managed");
  });

  // 12. model is undefined in result when not provided
  test("managed_required result has no model when none provided", async () => {
    mockStrategy = "managed_required";
    const result = await routedGenerateAvatar("a cute cat");
    expect(result.model).toBeUndefined();
  });

  // 9. Removed: Invalid strategy values are now rejected at config parse time
  // by the Zod schema, so they cannot reach getAvatarStrategy().
});

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

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
import { routedGenerateAvatar } from "../media/avatar-router.js";

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
    mockGeminiKey = "test-gemini-key";
    mockManagedAvailable = true;
    mockManagedResult = managedResponse();
    mockManagedError = undefined;
    mockGeminiResult = geminiResponse();
    generateManagedAvatarFn.mockClear();
    generateImageFn.mockClear();
    isManagedAvailableFn.mockClear();
  });

  test("uses managed path when available", async () => {
    const result = await routedGenerateAvatar("a cute cat");
    expect(result.pathUsed).toBe("managed");
    expect(result.imageBase64).toBe("base64data");
    expect(result.mimeType).toBe("image/png");
    expect(generateManagedAvatarFn).toHaveBeenCalledTimes(1);
    expect(generateImageFn).not.toHaveBeenCalled();
  });

  test("falls back to local when managed fails", async () => {
    mockManagedError = new Error("managed failed");
    const result = await routedGenerateAvatar("a cute cat");
    expect(result.pathUsed).toBe("local");
    expect(generateManagedAvatarFn).toHaveBeenCalledTimes(1);
    expect(generateImageFn).toHaveBeenCalledTimes(1);
  });

  test("goes to local when managed unavailable", async () => {
    mockManagedAvailable = false;
    const result = await routedGenerateAvatar("a cute cat");
    expect(result.pathUsed).toBe("local");
    expect(generateManagedAvatarFn).not.toHaveBeenCalled();
    expect(generateImageFn).toHaveBeenCalledTimes(1);
  });

  test("throws when managed unavailable and no Gemini key", async () => {
    mockManagedAvailable = false;
    mockGeminiKey = undefined;
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

  test("forwards model to generateManagedAvatar", async () => {
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

  test("model is undefined in result when not provided", async () => {
    const result = await routedGenerateAvatar("a cute cat");
    expect(result.model).toBeUndefined();
  });
});

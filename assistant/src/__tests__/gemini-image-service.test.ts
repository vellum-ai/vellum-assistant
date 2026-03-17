import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock @google/genai module — must be before importing the service
// ---------------------------------------------------------------------------

interface FakeResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: { mimeType?: string; data?: string };
      }>;
    };
  }>;
}

let lastGenerateParams: Record<string, unknown> | null = null;
let fakeResponse: FakeResponse = {};
let shouldThrow: Error | null = null;
let generateCallCount = 0;

class FakeApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

mock.module("@google/genai", () => ({
  GoogleGenAI: class MockGoogleGenAI {
    constructor(_opts: Record<string, unknown>) {}
    models = {
      generateContent: async (params: Record<string, unknown>) => {
        lastGenerateParams = params;
        generateCallCount++;
        if (shouldThrow) throw shouldThrow;
        return fakeResponse;
      },
    };
  },
  ApiError: FakeApiError,
}));

// Import after mocking
import {
  generateImage,
  mapGeminiError,
} from "../media/gemini-image-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function imageResponse(
  mimeType = "image/png",
  data = "base64data",
): FakeResponse {
  return {
    candidates: [
      {
        content: {
          parts: [{ inlineData: { mimeType, data } }],
        },
      },
    ],
  };
}

function imageWithTextResponse(
  text: string,
  mimeType = "image/png",
  data = "base64data",
): FakeResponse {
  return {
    candidates: [
      {
        content: {
          parts: [{ text }, { inlineData: { mimeType, data } }],
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastGenerateParams = null;
  fakeResponse = imageResponse();
  shouldThrow = null;
  generateCallCount = 0;
});

describe("generateImage", () => {
  test("generate mode returns images from response parts", async () => {
    fakeResponse = imageResponse("image/png", "abc123");

    const result = await generateImage(
      { type: "direct", apiKey: "test-key" },
      {
        prompt: "a cat",
        mode: "generate",
      },
    );

    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe("image/png");
    expect(result.images[0].dataBase64).toBe("abc123");
    expect(result.resolvedModel).toBe("gemini-3.1-flash-image-preview");
  });

  test("generate mode collects text commentary from response", async () => {
    fakeResponse = imageWithTextResponse("Here is your image");

    const result = await generateImage(
      { type: "direct", apiKey: "test-key" },
      {
        prompt: "a dog",
        mode: "generate",
      },
    );

    expect(result.text).toBe("Here is your image");
    expect(result.images).toHaveLength(1);
  });

  test("edit mode passes source images as inline data", async () => {
    fakeResponse = imageResponse();

    await generateImage(
      { type: "direct", apiKey: "test-key" },
      {
        prompt: "remove background",
        mode: "edit",
        sourceImages: [{ mimeType: "image/jpeg", dataBase64: "srcdata" }],
      },
    );

    expect(lastGenerateParams).not.toBeNull();
    const contents = (lastGenerateParams as Record<string, unknown>)
      .contents as Array<Record<string, unknown>>;
    const parts = contents[0].parts as Array<Record<string, unknown>>;

    // First part is the text prompt (with appended title instruction)
    expect((parts[0] as { text: string }).text).toContain("remove background");
    // Second part is the source image
    expect(parts[1]).toEqual({
      inlineData: { mimeType: "image/jpeg", data: "srcdata" },
    });
  });

  test("model validation rejects unknown models and defaults", async () => {
    fakeResponse = imageResponse();

    await generateImage(
      { type: "direct", apiKey: "test-key" },
      {
        prompt: "test",
        mode: "generate",
        model: "invalid-model",
      },
    );

    expect(lastGenerateParams).not.toBeNull();
    expect((lastGenerateParams as Record<string, unknown>).model).toBe(
      "gemini-3.1-flash-image-preview",
    );
  });

  test("model validation accepts allowed models", async () => {
    fakeResponse = imageResponse();

    await generateImage(
      { type: "direct", apiKey: "test-key" },
      {
        prompt: "test",
        mode: "generate",
        model: "gemini-3-pro-image-preview",
      },
    );

    expect((lastGenerateParams as Record<string, unknown>).model).toBe(
      "gemini-3-pro-image-preview",
    );
  });

  test("variants makes parallel calls", async () => {
    fakeResponse = imageResponse();

    const result = await generateImage(
      { type: "direct", apiKey: "test-key" },
      {
        prompt: "test",
        mode: "generate",
        variants: 3,
      },
    );

    expect(generateCallCount).toBe(3);
    expect(result.images).toHaveLength(3);
  });

  test("variants are clamped to 1-4", async () => {
    fakeResponse = imageResponse();

    await generateImage(
      { type: "direct", apiKey: "test-key" },
      {
        prompt: "test",
        mode: "generate",
        variants: 10,
      },
    );

    expect(generateCallCount).toBe(4);
  });

  test("variants defaults to 1", async () => {
    fakeResponse = imageResponse();

    await generateImage(
      { type: "direct", apiKey: "test-key" },
      {
        prompt: "test",
        mode: "generate",
      },
    );

    expect(generateCallCount).toBe(1);
  });

  test("handles empty candidates gracefully", async () => {
    fakeResponse = { candidates: [] };

    const result = await generateImage(
      { type: "direct", apiKey: "test-key" },
      {
        prompt: "test",
        mode: "generate",
      },
    );

    expect(result.images).toHaveLength(0);
    expect(result.text).toBeUndefined();
  });

  test("response config includes TEXT and IMAGE modalities", async () => {
    fakeResponse = imageResponse();

    await generateImage(
      { type: "direct", apiKey: "test-key" },
      {
        prompt: "test",
        mode: "generate",
      },
    );

    const config = (lastGenerateParams as Record<string, unknown>)
      .config as Record<string, unknown>;
    expect(config.responseModalities).toEqual(["TEXT", "IMAGE"]);
  });
});

describe("mapGeminiError", () => {
  test("maps 400 status to bad request message", () => {
    const msg = mapGeminiError(new FakeApiError(400, "bad"));
    expect(msg).toContain("invalid");
  });

  test("maps 401 status to auth message", () => {
    const msg = mapGeminiError(new FakeApiError(401, "unauth"));
    expect(msg).toContain("Authentication");
  });

  test("maps 403 status to auth message", () => {
    const msg = mapGeminiError(new FakeApiError(403, "forbidden"));
    expect(msg).toContain("Authentication");
  });

  test("maps 429 status to rate limit message", () => {
    const msg = mapGeminiError(new FakeApiError(429, "limit"));
    expect(msg).toContain("Rate limit");
  });

  test("maps 500 status to server error message", () => {
    const msg = mapGeminiError(new FakeApiError(500, "internal"));
    expect(msg).toContain("temporarily unavailable");
  });

  test("maps generic Error to message", () => {
    const msg = mapGeminiError(new Error("network fail"));
    expect(msg).toContain("network fail");
  });

  test("maps unknown error to generic message", () => {
    const msg = mapGeminiError("something");
    expect(msg).toContain("unexpected error");
  });
});

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock openai + openai/uploads — must be before importing the service
// ---------------------------------------------------------------------------

interface FakeImagesResponse {
  data?: Array<{ b64_json?: string }>;
}

let lastGenerateParams: Record<string, unknown> | null = null;
let lastEditParams: Record<string, unknown> | null = null;
let lastConstructorOptions: Record<string, unknown> | null = null;
let fakeResponse: FakeImagesResponse = { data: [] };
let shouldThrow: Error | null = null;
let generateCallCount = 0;
let editCallCount = 0;
let toFileCallCount = 0;
let toFileCalls: Array<{
  input: unknown;
  filename: string;
  options?: { type?: string };
}> = [];

// Simulate OpenAI.APIError — the real SDK's APIError is a class attached as a
// static property on the default export.
class FakeAPIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "APIError";
  }
}

mock.module("openai", () => {
  class MockOpenAI {
    static APIError = FakeAPIError;
    images: {
      generate: (
        params: Record<string, unknown>,
      ) => Promise<FakeImagesResponse>;
      edit: (params: Record<string, unknown>) => Promise<FakeImagesResponse>;
    };
    constructor(opts: Record<string, unknown>) {
      lastConstructorOptions = opts;
      this.images = {
        generate: async (params: Record<string, unknown>) => {
          lastGenerateParams = params;
          generateCallCount++;
          if (shouldThrow) throw shouldThrow;
          return fakeResponse;
        },
        edit: async (params: Record<string, unknown>) => {
          lastEditParams = params;
          editCallCount++;
          if (shouldThrow) throw shouldThrow;
          return fakeResponse;
        },
      };
    }
  }
  return { default: MockOpenAI, APIError: FakeAPIError };
});

// Sentinel value returned from mocked `toFile` so tests can verify it was used
// to wrap each source image before being passed to `images.edit`.
const TO_FILE_SENTINEL = Symbol("toFile-sentinel");

mock.module("openai/uploads", () => ({
  toFile: async (
    input: unknown,
    filename: string,
    options?: { type?: string },
  ) => {
    toFileCallCount++;
    toFileCalls.push({ input, filename, options });
    return { __sentinel: TO_FILE_SENTINEL, filename, options };
  },
}));

// Import after mocking
import {
  generateImageOpenAI,
  mapOpenAIError,
} from "../media/openai-image-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function imageResponse(
  ...entries: Array<{ b64_json?: string }>
): FakeImagesResponse {
  return { data: entries };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastGenerateParams = null;
  lastEditParams = null;
  lastConstructorOptions = null;
  fakeResponse = imageResponse({ b64_json: "abc123" });
  shouldThrow = null;
  generateCallCount = 0;
  editCallCount = 0;
  toFileCallCount = 0;
  toFileCalls = [];
});

describe("generateImageOpenAI", () => {
  test("generate mode returns a single variant", async () => {
    fakeResponse = imageResponse({ b64_json: "abc123" });

    const result = await generateImageOpenAI(
      { type: "direct", apiKey: "test-key" },
      { prompt: "a cat", mode: "generate" },
    );

    expect(generateCallCount).toBe(1);
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe("image/png");
    expect(result.images[0].dataBase64).toBe("abc123");
    expect(result.text).toBeUndefined();
    expect(result.resolvedModel).toBe("gpt-image-2");
  });

  test("generate with n: 3 forwards the n param (not parallel calls)", async () => {
    fakeResponse = imageResponse(
      { b64_json: "a" },
      { b64_json: "b" },
      { b64_json: "c" },
    );

    const result = await generateImageOpenAI(
      { type: "direct", apiKey: "test-key" },
      { prompt: "a cat", mode: "generate", variants: 3 },
    );

    // Exactly one call; n forwarded to the SDK instead of calling thrice.
    expect(generateCallCount).toBe(1);
    expect((lastGenerateParams as Record<string, unknown>).n).toBe(3);
    expect(result.images).toHaveLength(3);
    expect(result.images.map((i) => i.dataBase64)).toEqual(["a", "b", "c"]);
  });

  test("variants are clamped to [1, MAX_VARIANTS]", async () => {
    fakeResponse = imageResponse({ b64_json: "x" });

    await generateImageOpenAI(
      { type: "direct", apiKey: "test-key" },
      { prompt: "test", mode: "generate", variants: 10 },
    );
    expect((lastGenerateParams as Record<string, unknown>).n).toBe(4);

    await generateImageOpenAI(
      { type: "direct", apiKey: "test-key" },
      { prompt: "test", mode: "generate", variants: 0 },
    );
    expect((lastGenerateParams as Record<string, unknown>).n).toBe(1);
  });

  test("model falls back to gpt-image-2 when unknown", async () => {
    fakeResponse = imageResponse({ b64_json: "x" });

    await generateImageOpenAI(
      { type: "direct", apiKey: "test-key" },
      { prompt: "test", mode: "generate", model: "invalid-model" },
    );

    expect((lastGenerateParams as Record<string, unknown>).model).toBe(
      "gpt-image-2",
    );
  });

  test("edit mode with one source image calls toFile once and passes files[] to edit", async () => {
    fakeResponse = imageResponse({ b64_json: "edited" });

    await generateImageOpenAI(
      { type: "direct", apiKey: "test-key" },
      {
        prompt: "remove background",
        mode: "edit",
        sourceImages: [{ mimeType: "image/jpeg", dataBase64: "srcdata" }],
      },
    );

    expect(editCallCount).toBe(1);
    expect(generateCallCount).toBe(0);
    expect(toFileCallCount).toBe(1);
    expect(toFileCalls[0].filename).toBe("input.png");
    expect(toFileCalls[0].options).toEqual({ type: "image/jpeg" });

    const editParams = lastEditParams as Record<string, unknown>;
    expect(editParams.prompt).toBe("remove background");
    const image = editParams.image as Array<Record<string, unknown>>;
    expect(Array.isArray(image)).toBe(true);
    expect(image).toHaveLength(1);
    expect(image[0].__sentinel).toBe(TO_FILE_SENTINEL);
  });

  test("edit mode with multiple source images passes an array of files", async () => {
    fakeResponse = imageResponse({ b64_json: "edited" });

    await generateImageOpenAI(
      { type: "direct", apiKey: "test-key" },
      {
        prompt: "merge",
        mode: "edit",
        sourceImages: [
          { mimeType: "image/png", dataBase64: "one" },
          { mimeType: "image/jpeg", dataBase64: "two" },
          { mimeType: "image/webp", dataBase64: "three" },
        ],
      },
    );

    expect(toFileCallCount).toBe(3);
    expect(toFileCalls[0].options?.type).toBe("image/png");
    expect(toFileCalls[1].options?.type).toBe("image/jpeg");
    expect(toFileCalls[2].options?.type).toBe("image/webp");

    const editParams = lastEditParams as Record<string, unknown>;
    const image = editParams.image as Array<Record<string, unknown>>;
    expect(image).toHaveLength(3);
    for (const entry of image) {
      expect(entry.__sentinel).toBe(TO_FILE_SENTINEL);
    }
  });

  test("direct credentials construct OpenAI without a baseURL", async () => {
    fakeResponse = imageResponse({ b64_json: "x" });

    await generateImageOpenAI(
      { type: "direct", apiKey: "my-direct-key" },
      { prompt: "test", mode: "generate" },
    );

    expect(lastConstructorOptions).not.toBeNull();
    expect((lastConstructorOptions as Record<string, unknown>).apiKey).toBe(
      "my-direct-key",
    );
    expect(
      (lastConstructorOptions as Record<string, unknown>).baseURL,
    ).toBeUndefined();
  });

  test("managed-proxy credentials set baseURL on the OpenAI client", async () => {
    fakeResponse = imageResponse({ b64_json: "x" });

    await generateImageOpenAI(
      {
        type: "managed-proxy",
        assistantApiKey: "proxy-key",
        baseUrl: "https://proxy.example.com/v1",
      },
      { prompt: "test", mode: "generate" },
    );

    expect(lastConstructorOptions).not.toBeNull();
    expect((lastConstructorOptions as Record<string, unknown>).apiKey).toBe(
      "proxy-key",
    );
    expect((lastConstructorOptions as Record<string, unknown>).baseURL).toBe(
      "https://proxy.example.com/v1",
    );
  });

  test("title is derived from the first 6 words of the prompt and sanitized", async () => {
    fakeResponse = imageResponse({ b64_json: "one" }, { b64_json: "two" });

    const result = await generateImageOpenAI(
      { type: "direct", apiKey: "k" },
      {
        prompt: "A cute orange cat sleeping on a warm windowsill at sunset!",
        mode: "generate",
        variants: 2,
      },
    );

    // First 6 words: "A cute orange cat sleeping on" -> sanitized
    // (non-[\w\s-] stripped, whitespace -> '-', lowercased, sliced to 60).
    expect(result.images).toHaveLength(2);
    for (const img of result.images) {
      expect(img.title).toBe("a-cute-orange-cat-sleeping-on");
    }
  });

  test("title uses the whole prompt when it has fewer than 6 words", async () => {
    fakeResponse = imageResponse({ b64_json: "x" });

    const result = await generateImageOpenAI(
      { type: "direct", apiKey: "k" },
      { prompt: "tiny dog", mode: "generate" },
    );

    expect(result.images[0].title).toBe("tiny-dog");
  });

  test("entries without b64_json are skipped", async () => {
    fakeResponse = imageResponse(
      { b64_json: "present" },
      { b64_json: undefined },
      {},
    );

    const result = await generateImageOpenAI(
      { type: "direct", apiKey: "k" },
      { prompt: "test", mode: "generate" },
    );

    expect(result.images).toHaveLength(1);
    expect(result.images[0].dataBase64).toBe("present");
  });

  test("empty data array returns no images", async () => {
    fakeResponse = { data: [] };

    const result = await generateImageOpenAI(
      { type: "direct", apiKey: "k" },
      { prompt: "test", mode: "generate" },
    );

    expect(result.images).toHaveLength(0);
    expect(result.text).toBeUndefined();
    expect(result.resolvedModel).toBe("gpt-image-2");
  });
});

describe("mapOpenAIError", () => {
  test("maps 400 status to bad request message", () => {
    const msg = mapOpenAIError(new FakeAPIError(400, "bad"));
    expect(msg).toContain("invalid");
  });

  test("maps 401 status to auth message", () => {
    const msg = mapOpenAIError(new FakeAPIError(401, "unauth"));
    expect(msg).toContain("Authentication");
  });

  test("maps 403 status to auth message", () => {
    const msg = mapOpenAIError(new FakeAPIError(403, "forbidden"));
    expect(msg).toContain("Authentication");
  });

  test("maps 429 status to rate limit message", () => {
    const msg = mapOpenAIError(new FakeAPIError(429, "limit"));
    expect(msg).toContain("Rate limit");
  });

  test("maps 500 status to server error message", () => {
    const msg = mapOpenAIError(new FakeAPIError(500, "internal"));
    expect(msg).toContain("temporarily unavailable");
  });

  test("maps generic Error to message", () => {
    const msg = mapOpenAIError(new Error("network fail"));
    expect(msg).toContain("network fail");
  });

  test("maps unknown error to generic message", () => {
    const msg = mapOpenAIError("something");
    expect(msg).toContain("unexpected error");
  });
});

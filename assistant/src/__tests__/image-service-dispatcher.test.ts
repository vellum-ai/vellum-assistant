import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ImageGenCredentials,
  ImageGenerationRequest,
  ImageGenerationResult,
} from "../media/types.js";

// ---------------------------------------------------------------------------
// Mock recording state
// ---------------------------------------------------------------------------

interface GenerateCall {
  credentials: ImageGenCredentials;
  request: ImageGenerationRequest;
}

let geminiCalls: GenerateCall[] = [];
let openaiCalls: GenerateCall[] = [];
let geminiErrorCalls: unknown[] = [];
let openaiErrorCalls: unknown[] = [];

let geminiResult: ImageGenerationResult = {
  images: [],
  resolvedModel: "gemini-mock",
};
let openaiResult: ImageGenerationResult = {
  images: [],
  resolvedModel: "openai-mock",
};

// ---------------------------------------------------------------------------
// Mock underlying services — must run before the module under test is imported
// ---------------------------------------------------------------------------

mock.module("../media/gemini-image-service.js", () => ({
  generateImage: async (
    credentials: ImageGenCredentials,
    request: ImageGenerationRequest,
  ): Promise<ImageGenerationResult> => {
    geminiCalls.push({ credentials, request });
    return geminiResult;
  },
  mapGeminiError: (error: unknown): string => {
    geminiErrorCalls.push(error);
    return "gemini-mapped";
  },
}));

mock.module("../media/openai-image-service.js", () => ({
  generateImageOpenAI: async (
    credentials: ImageGenCredentials,
    request: ImageGenerationRequest,
  ): Promise<ImageGenerationResult> => {
    openaiCalls.push({ credentials, request });
    return openaiResult;
  },
  mapOpenAIError: (error: unknown): string => {
    openaiErrorCalls.push(error);
    return "openai-mapped";
  },
}));

// Import after mocking
import {
  generateImage,
  mapImageGenError,
  providerForModel,
} from "../media/image-service.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const directCreds: ImageGenCredentials = {
  type: "direct",
  apiKey: "test-key",
};

const request: ImageGenerationRequest = {
  prompt: "a friendly test image",
  mode: "generate",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("image-service dispatcher", () => {
  beforeEach(() => {
    geminiCalls = [];
    openaiCalls = [];
    geminiErrorCalls = [];
    openaiErrorCalls = [];
    geminiResult = {
      images: [{ mimeType: "image/png", dataBase64: "gemini-bytes" }],
      resolvedModel: "gemini-3.1-flash-image-preview",
    };
    openaiResult = {
      images: [{ mimeType: "image/png", dataBase64: "openai-bytes" }],
      resolvedModel: "gpt-image-2",
    };
  });

  test("generateImage('gemini', ...) delegates to the Gemini implementation", async () => {
    const result = await generateImage("gemini", directCreds, request);

    expect(geminiCalls).toHaveLength(1);
    expect(geminiCalls[0]?.credentials).toBe(directCreds);
    expect(geminiCalls[0]?.request).toBe(request);
    expect(openaiCalls).toHaveLength(0);
    expect(result).toEqual(geminiResult);
  });

  test("generateImage('openai', ...) delegates to the OpenAI implementation", async () => {
    const result = await generateImage("openai", directCreds, request);

    expect(openaiCalls).toHaveLength(1);
    expect(openaiCalls[0]?.credentials).toBe(directCreds);
    expect(openaiCalls[0]?.request).toBe(request);
    expect(geminiCalls).toHaveLength(0);
    expect(result).toEqual(openaiResult);
  });

  test("mapImageGenError('gemini', err) delegates to mapGeminiError", () => {
    const err = new Error("boom");
    const mapped = mapImageGenError("gemini", err);

    expect(geminiErrorCalls).toEqual([err]);
    expect(openaiErrorCalls).toEqual([]);
    expect(mapped).toBe("gemini-mapped");
  });

  test("mapImageGenError('openai', err) delegates to mapOpenAIError", () => {
    const err = new Error("kapow");
    const mapped = mapImageGenError("openai", err);

    expect(openaiErrorCalls).toEqual([err]);
    expect(geminiErrorCalls).toEqual([]);
    expect(mapped).toBe("openai-mapped");
  });
});

describe("providerForModel", () => {
  test("returns fallback when model is undefined", () => {
    expect(providerForModel(undefined, "gemini")).toBe("gemini");
    expect(providerForModel(undefined, "openai")).toBe("openai");
  });

  test("routes gpt-* models to openai regardless of fallback", () => {
    expect(providerForModel("gpt-image-2", "gemini")).toBe("openai");
    expect(providerForModel("gpt-image-2", "openai")).toBe("openai");
    expect(providerForModel("gpt-4o-image", "gemini")).toBe("openai");
  });

  test("routes dall-e-* models to openai regardless of fallback", () => {
    expect(providerForModel("dall-e-3", "gemini")).toBe("openai");
    expect(providerForModel("dall-e-2", "gemini")).toBe("openai");
  });

  test("routes gemini-* models to gemini regardless of fallback", () => {
    expect(providerForModel("gemini-3.1-flash-image-preview", "openai")).toBe(
      "gemini",
    );
    expect(providerForModel("gemini-3-pro-image-preview", "openai")).toBe(
      "gemini",
    );
  });

  test("returns fallback for unrecognized model prefixes", () => {
    expect(providerForModel("unknown-model", "gemini")).toBe("gemini");
    expect(providerForModel("unknown-model", "openai")).toBe("openai");
    expect(providerForModel("", "gemini")).toBe("gemini");
  });
});

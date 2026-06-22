import { describe, expect, test } from "bun:test";

import OpenAI from "openai";

import { detectVisionNotSupported } from "../chat-completions-provider.js";

function buildApiError(
  status: number,
  body: unknown,
): InstanceType<typeof OpenAI.APIError> {
  return new OpenAI.APIError(
    status,
    body as Record<string, unknown>,
    undefined,
    new Headers(),
  );
}

describe("detectVisionNotSupported", () => {
  test("detects OpenRouter 'No endpoints found that support image input'", () => {
    const err = buildApiError(404, {
      error: {
        message: "No endpoints found that support image input",
        code: 404,
      },
    });
    expect(detectVisionNotSupported(err)).toBe(true);
  });

  test("detects 'does not support image' phrasing", () => {
    const err = buildApiError(400, {
      error: {
        message: "This model does not support image input",
      },
    });
    expect(detectVisionNotSupported(err)).toBe(true);
  });

  test("detects 'image input is not supported'", () => {
    const err = buildApiError(400, {
      error: {
        message: "image input is not supported for this model",
      },
    });
    expect(detectVisionNotSupported(err)).toBe(true);
  });

  test("detects 'vision is not supported'", () => {
    const err = buildApiError(400, {
      error: {
        message: "Vision is not supported by this model",
      },
    });
    expect(detectVisionNotSupported(err)).toBe(true);
  });

  test("returns false for unrelated errors", () => {
    const err = buildApiError(429, {
      error: {
        message: "Rate limit exceeded",
      },
    });
    expect(detectVisionNotSupported(err)).toBe(false);
  });

  test("returns false for context overflow", () => {
    const err = buildApiError(400, {
      error: {
        code: "context_length_exceeded",
        message: "This model's maximum context length is 128000 tokens",
      },
    });
    expect(detectVisionNotSupported(err)).toBe(false);
  });
});

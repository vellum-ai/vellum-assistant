import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  generateImageOpenRouter,
  mapOpenRouterError,
} from "./openrouter-image-service.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("generateImageOpenRouter", () => {
  test("generates images through the dedicated OpenRouter Images API", async () => {
    let request: Request | undefined;
    globalThis.fetch = mock(async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        data: [
          { b64_json: "png-data", media_type: "image/png" },
          { b64_json: "svg-data", media_type: "image/svg+xml" },
        ],
      });
    }) as typeof fetch;

    const result = await generateImageOpenRouter(
      { type: "direct", apiKey: "or-key" },
      {
        prompt: "a friendly robot",
        mode: "generate",
        model: "google/gemini-3.1-flash-image-preview",
        variants: 2,
      },
    );

    expect(request?.url).toBe("https://openrouter.ai/api/v1/images");
    expect(request?.headers.get("authorization")).toBe("Bearer or-key");
    expect(await request?.json()).toEqual({
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "a friendly robot",
      n: 2,
    });
    expect(result).toEqual({
      images: [
        { mimeType: "image/png", dataBase64: "png-data" },
        { mimeType: "image/svg+xml", dataBase64: "svg-data" },
      ],
      text: undefined,
      resolvedModel: "google/gemini-3.1-flash-image-preview",
    });
  });

  test("sends source images as data URL references for edits", async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = mock(async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ data: [] });
    }) as typeof fetch;

    await generateImageOpenRouter(
      { type: "direct", apiKey: "or-key" },
      {
        prompt: "make it watercolor",
        mode: "edit",
        sourceImages: [{ mimeType: "image/jpeg", dataBase64: "abc123" }],
      },
    );

    expect(body?.input_references).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64,abc123" },
      },
    ]);
  });

  test("surfaces the provider's invalid-request message", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { error: { message: "Model does not support image output" } },
        { status: 400 },
      ),
    ) as typeof fetch;

    try {
      await generateImageOpenRouter(
        { type: "direct", apiKey: "or-key" },
        { prompt: "a cat", mode: "generate", model: "text-only/model" },
      );
      throw new Error("expected request to fail");
    } catch (error) {
      expect(mapOpenRouterError(error)).toBe(
        "The OpenRouter image request was invalid: Model does not support image output",
      );
    }
  });
});

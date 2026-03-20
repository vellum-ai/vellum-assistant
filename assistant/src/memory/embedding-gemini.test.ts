import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { GeminiEmbeddingBackend } from "./embedding-gemini.js";

function makeSuccessResponse(values: number[]) {
  return new Response(JSON.stringify({ embedding: { values } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GeminiEmbeddingBackend", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock(() =>
      Promise.resolve(makeSuccessResponse([0.1, 0.2, 0.3])),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("text inputs", () => {
    test("sends text as parts: [{ text }]", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await backend.embed(["hello world"]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("models/test-model:embedContent");
      expect(url).toContain("key=test-key");

      const body = JSON.parse(init.body as string);
      expect(body.model).toBe("models/test-model");
      expect(body.content).toEqual({ parts: [{ text: "hello world" }] });
    });

    test("handles TextEmbeddingInput objects", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await backend.embed([{ type: "text", text: "structured text" }]);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.content).toEqual({ parts: [{ text: "structured text" }] });
    });
  });

  describe("image inputs", () => {
    test("sends image as inline_data with base64", async () => {
      const imageData = Buffer.from("fake-png-data");
      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await backend.embed([
        { type: "image", data: imageData, mimeType: "image/png" },
      ]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.content).toEqual({
        parts: [
          {
            inline_data: {
              mime_type: "image/png",
              data: imageData.toString("base64"),
            },
          },
        ],
      });
    });
  });

  describe("audio inputs", () => {
    test("sends audio as inline_data with base64", async () => {
      const audioData = Buffer.from("fake-audio-data");
      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await backend.embed([
        { type: "audio", data: audioData, mimeType: "audio/mp3" },
      ]);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.content).toEqual({
        parts: [
          {
            inline_data: {
              mime_type: "audio/mp3",
              data: audioData.toString("base64"),
            },
          },
        ],
      });
    });
  });

  describe("video inputs", () => {
    test("sends video as inline_data with base64", async () => {
      const videoData = Buffer.from("fake-video-data");
      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await backend.embed([
        { type: "video", data: videoData, mimeType: "video/mp4" },
      ]);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.content).toEqual({
        parts: [
          {
            inline_data: {
              mime_type: "video/mp4",
              data: videoData.toString("base64"),
            },
          },
        ],
      });
    });
  });

  describe("taskType and outputDimensionality", () => {
    test("includes taskType in request body when configured", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        taskType: "RETRIEVAL_DOCUMENT",
      });
      await backend.embed(["hello"]);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.taskType).toBe("RETRIEVAL_DOCUMENT");
    });

    test("includes outputDimensionality in request body when dimensions configured", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        dimensions: 256,
      });
      await backend.embed(["hello"]);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.outputDimensionality).toBe(256);
    });

    test("includes both taskType and outputDimensionality when both configured", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        taskType: "SEMANTIC_SIMILARITY",
        dimensions: 512,
      });
      await backend.embed(["hello"]);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.taskType).toBe("SEMANTIC_SIMILARITY");
      expect(body.outputDimensionality).toBe(512);
    });

    test("omits taskType when not configured", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await backend.embed(["hello"]);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.taskType).toBeUndefined();
    });

    test("omits outputDimensionality when not configured", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await backend.embed(["hello"]);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.outputDimensionality).toBeUndefined();
    });

    test("omits both when options is undefined", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await backend.embed(["hello"]);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.taskType).toBeUndefined();
      expect(body.outputDimensionality).toBeUndefined();
      expect(Object.keys(body)).toEqual(["model", "content"]);
    });
  });

  describe("error handling", () => {
    test("throws on non-OK response", async () => {
      mockFetch = mock(() =>
        Promise.resolve(new Response("Internal Server Error", { status: 500 })),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await expect(backend.embed(["hello"])).rejects.toThrow(
        "Gemini embeddings request failed (500): Internal Server Error",
      );
    });

    test("throws when response is missing embedding values", async () => {
      mockFetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await expect(backend.embed(["hello"])).rejects.toThrow(
        "Gemini embeddings response missing vector values",
      );
    });

    test("throws when embedding values array is empty", async () => {
      mockFetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ embedding: { values: [] } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      await expect(backend.embed(["hello"])).rejects.toThrow(
        "Gemini embeddings response missing vector values",
      );
    });
  });

  describe("multiple inputs", () => {
    test("embeds multiple inputs sequentially", async () => {
      let callCount = 0;
      mockFetch = mock(() => {
        callCount++;
        return Promise.resolve(
          makeSuccessResponse([0.1 * callCount, 0.2 * callCount]),
        );
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const backend = new GeminiEmbeddingBackend("test-key", "test-model");
      const result = await backend.embed(["hello", "world"]);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual([0.1, 0.2]);
      expect(result[1]).toEqual([0.2, 0.4]);
    });
  });
});

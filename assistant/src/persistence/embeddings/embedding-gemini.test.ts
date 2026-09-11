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
      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        bypassWorker: true,
      });
      await backend.embed(["hello world"]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("models/test-model:embedContent");
      expect(url).toContain("key=test-key");

      const body = JSON.parse(init.body as string);
      expect(body.model).toBeUndefined();
      expect(body.content).toEqual({ parts: [{ text: "hello world" }] });
    });

    test("handles TextEmbeddingInput objects", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        bypassWorker: true,
      });
      await backend.embed([{ type: "text", text: "structured text" }]);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.content).toEqual({ parts: [{ text: "structured text" }] });
    });
  });

  describe("image inputs", () => {
    test("sends image as inline_data with base64", async () => {
      const imageData = Buffer.from("fake-png-data");
      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        bypassWorker: true,
      });
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
      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        bypassWorker: true,
      });
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
      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        bypassWorker: true,
      });
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
        bypassWorker: true,
      });
      await backend.embed(["hello"]);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.taskType).toBe("RETRIEVAL_DOCUMENT");
    });

    test("includes outputDimensionality in request body when dimensions configured", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        dimensions: 256,
        bypassWorker: true,
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
        bypassWorker: true,
      });
      await backend.embed(["hello"]);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.taskType).toBe("SEMANTIC_SIMILARITY");
      expect(body.outputDimensionality).toBe(512);
    });

    test("omits taskType when not configured", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        bypassWorker: true,
      });
      await backend.embed(["hello"]);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.taskType).toBeUndefined();
    });

    test("omits outputDimensionality when not configured", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        bypassWorker: true,
      });
      await backend.embed(["hello"]);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.outputDimensionality).toBeUndefined();
    });

    test("omits both when options is undefined", async () => {
      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        bypassWorker: true,
      });
      await backend.embed(["hello"]);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.taskType).toBeUndefined();
      expect(body.outputDimensionality).toBeUndefined();
      expect(Object.keys(body)).toEqual(["content"]);
    });
  });

  describe("error handling", () => {
    test("throws on non-OK response", async () => {
      mockFetch = mock(() =>
        Promise.resolve(new Response("Internal Server Error", { status: 500 })),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        bypassWorker: true,
      });
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

      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        bypassWorker: true,
      });
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

      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        bypassWorker: true,
      });
      await expect(backend.embed(["hello"])).rejects.toThrow(
        "Gemini embeddings response missing vector values",
      );
    });
  });

  describe("multiple inputs", () => {
    test("embeds multiple text inputs in one batch call in bypass mode", async () => {
      mockFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              embeddings: [{ values: [0.1, 0.2] }, { values: [0.2, 0.4] }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
        bypassWorker: true,
      });
      const result = await backend.embed(["hello", "world"]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual([0.1, 0.2]);
      expect(result[1]).toEqual([0.2, 0.4]);
    });
  });

  describe("managed proxy transport", () => {
    test("routes through managed proxy base URL when managedBaseUrl is set", async () => {
      const backend = new GeminiEmbeddingBackend(
        "ast-managed-key",
        "gemini-embedding-2",
        {
          managedBaseUrl:
            "https://platform.example.com/v1/runtime-proxy/gemini",
          bypassWorker: true,
        },
      );
      await backend.embed(["hello"]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        "https://platform.example.com/v1/runtime-proxy/gemini/v1beta/models/gemini-embedding-2:embedContent",
      );
      // Should NOT have key= query param
      expect(url).not.toContain("key=");
      // Should have Bearer auth header
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer ast-managed-key");
      // Managed path must NOT include `model` in the body — Gemini models it
      // as a protobuf oneof populated from the URL path (internally `_model`)
      // and rejects the duplicate with "oneof field '_model' is already set".
      // See the comment in embedSingle() for the full invariant.
      const body = JSON.parse(init.body as string);
      expect(body.model).toBeUndefined();
      expect(body._model).toBeUndefined();
    });

    test("never sets `model` or `_model` in the request body (oneof invariant)", async () => {
      // Regression for JARVIS-587: every embed_segment job was failing with
      // `Invalid value (oneof), oneof field '_model' is already set. Cannot
      // set 'model'`. Ensure neither field is ever present on the wire,
      // regardless of transport.
      const managedBackend = new GeminiEmbeddingBackend(
        "ast-managed-key",
        "gemini-embedding-2",
        {
          managedBaseUrl:
            "https://platform.example.com/v1/runtime-proxy/gemini",
          taskType: "RETRIEVAL_DOCUMENT",
          dimensions: 3072,
          bypassWorker: true,
        },
      );
      await managedBackend.embed(["hello"]);

      const directBackend = new GeminiEmbeddingBackend(
        "direct-key",
        "test-model",
        { bypassWorker: true },
      );
      await directBackend.embed(["hello"]);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      for (const call of mockFetch.mock.calls) {
        const [, init] = call as [string, RequestInit];
        const body = JSON.parse(init.body as string);
        expect(body.model).toBeUndefined();
        expect(body._model).toBeUndefined();
      }
    });

    test("uses direct Google API URL when managedBaseUrl is not set", async () => {
      const backend = new GeminiEmbeddingBackend("direct-key", "test-model", {
        bypassWorker: true,
      });
      await backend.embed(["hello"]);

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("generativelanguage.googleapis.com");
      expect(url).toContain("key=direct-key");
      // Should NOT have Authorization header
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    });

    test("includes outputDimensionality with managed proxy", async () => {
      const backend = new GeminiEmbeddingBackend(
        "ast-managed-key",
        "gemini-embedding-2",
        {
          managedBaseUrl:
            "https://platform.example.com/v1/runtime-proxy/gemini",
          dimensions: 3072,
          bypassWorker: true,
        },
      );
      await backend.embed(["hello"]);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.outputDimensionality).toBe(3072);
    });
  });
});

/** The input index encoded in a `t<n>` fixture text. */
function textIndex(text: string): number {
  return Number(text.replace(/^t/, ""));
}

/**
 * A fetch stub that answers both routes: a single `embedContent` call with a
 * vector encoding its input index, and a `batchEmbedContents` call with one
 * such vector per request in order, unless `batch` overrides its outcome.
 */
function routedFetch(batch?: {
  status?: number;
  statusOnFirstCall?: number;
  body?: unknown;
}) {
  let batchCalls = 0;
  return mock(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as {
      requests?: Array<{ content: { parts: Array<{ text?: string }> } }>;
      content?: { parts: Array<{ text?: string }> };
    };
    if (url.includes(":batchEmbedContents")) {
      batchCalls += 1;
      const status =
        batchCalls === 1 && batch?.statusOnFirstCall !== undefined
          ? batch.statusOnFirstCall
          : (batch?.status ?? 200);
      if (status !== 200) {
        return new Response("no batch here", { status });
      }
      const embeddings =
        batch?.body !== undefined
          ? batch.body
          : body.requests!.map((request) => ({
              values: [textIndex(request.content.parts[0]!.text!)],
            }));
      return new Response(JSON.stringify({ embeddings }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const part = body.content!.parts[0]!;
    return makeSuccessResponse([
      part.text !== undefined ? textIndex(part.text) : -1,
    ]);
  });
}

function texts(count: number): string[] {
  return Array.from({ length: count }, (_v, i) => `t${i}`);
}

function calledUrls(fetchMock: ReturnType<typeof mock>): string[] {
  return fetchMock.mock.calls.map((call) => (call as [string])[0]);
}

describe("GeminiEmbeddingBackend: batched text inputs", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("250 texts go out as three batchEmbedContents calls of 100, 100, and 50, vectors in input order", async () => {
    const fetchMock = routedFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      bypassWorker: true,
    });

    const vectors = await backend.embed(texts(250));

    const urls = calledUrls(fetchMock);
    expect(urls).toHaveLength(3);
    expect(urls.every((url) => url.includes(":batchEmbedContents"))).toBe(true);
    const sizes = fetchMock.mock.calls.map(
      (call) =>
        (
          JSON.parse((call as [string, RequestInit])[1].body as string) as {
            requests: unknown[];
          }
        ).requests.length,
    );
    expect(sizes).toEqual([100, 100, 50]);
    expect(vectors.map((v) => v[0])).toEqual(texts(250).map(textIndex));
  });

  test("each batched request names the model with the models/ prefix and carries taskType and outputDimensionality", async () => {
    const fetchMock = routedFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      bypassWorker: true,
      taskType: "RETRIEVAL_DOCUMENT",
      dimensions: 256,
    });

    await backend.embed(texts(2));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/models/test-model:batchEmbedContents?key=test-key");
    const body = JSON.parse(init.body as string) as {
      requests: Array<Record<string, unknown>>;
      model?: unknown;
    };
    expect(body.model).toBeUndefined();
    expect(body.requests).toEqual([
      {
        model: "models/test-model",
        content: { parts: [{ text: "t0" }] },
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: 256,
      },
      {
        model: "models/test-model",
        content: { parts: [{ text: "t1" }] },
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: 256,
      },
    ]);
  });

  test("a lone text keeps the embedContent route", async () => {
    const fetchMock = routedFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      bypassWorker: true,
    });

    const vectors = await backend.embed(["t7"]);

    expect(calledUrls(fetchMock)).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models/test-model:embedContent?key=test-key",
    ]);
    expect(vectors).toEqual([[7]]);
  });

  test("multimodal inputs take the single route while the texts around them batch, in input order", async () => {
    const fetchMock = routedFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      bypassWorker: true,
    });

    const vectors = await backend.embed([
      "t0",
      { type: "image", data: Buffer.from("png"), mimeType: "image/png" },
      "t2",
      "t3",
    ]);

    const urls = calledUrls(fetchMock);
    expect(
      urls.map((url) =>
        url.includes(":batchEmbedContents") ? "batch" : "single",
      ),
    ).toEqual(["single", "single", "batch"]);
    expect(vectors.map((v) => v[0])).toEqual([0, -1, 2, 3]);
  });

  test("a batch route that does not exist falls back to single calls and is not tried again", async () => {
    const fetchMock = routedFetch({ status: 404 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      bypassWorker: true,
    });

    const first = await backend.embed(texts(3));
    expect(first.map((v) => v[0])).toEqual([0, 1, 2]);
    // One failed batch attempt, then three singles.
    expect(
      calledUrls(fetchMock).map((url) => url.includes(":batchEmbedContents")),
    ).toEqual([true, false, false, false]);

    const second = await backend.embed(["t4", "t5"]);
    expect(second.map((v) => v[0])).toEqual([4, 5]);
    // No further batch attempt: straight to singles.
    expect(
      calledUrls(fetchMock)
        .slice(4)
        .every((url) => url.includes(":embedContent")),
    ).toBe(true);
    expect(fetchMock.mock.calls).toHaveLength(6);
  });

  test("a batch rejected as a bad request is re-sent as singles; the next batch is tried again", async () => {
    const fetchMock = routedFetch({ statusOnFirstCall: 400 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      bypassWorker: true,
    });

    const vectors = await backend.embed(texts(150));

    expect(vectors.map((v) => v[0])).toEqual(texts(150).map(textIndex));
    const kinds = calledUrls(fetchMock).map((url) =>
      url.includes(":batchEmbedContents") ? "batch" : "single",
    );
    // The rejected first batch, its 100 singles, then the second batch of 50.
    expect(kinds).toHaveLength(102);
    expect(kinds[0]).toBe("batch");
    expect(kinds.slice(1, 101).every((kind) => kind === "single")).toBe(true);
    expect(kinds[101]).toBe("batch");
  });

  test("a batch that fails with a server error is re-sent as singles, so a fault confined to the batch route never fails the embed", async () => {
    const fetchMock = routedFetch({ status: 503 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      bypassWorker: true,
    });

    const vectors = await backend.embed(texts(3));

    expect(vectors.map((v) => v[0])).toEqual([0, 1, 2]);
    expect(
      calledUrls(fetchMock).map((url) => url.includes(":batchEmbedContents")),
    ).toEqual([true, false, false, false]);
  });

  test("a batch request that cannot be sent is re-sent as singles, while a cancelled request rethrows", async () => {
    let batchCalls = 0;
    const fetchMock = mock(async (url: string, init: RequestInit) => {
      if (url.includes(":batchEmbedContents")) {
        batchCalls += 1;
        throw new TypeError("fetch failed");
      }
      const body = JSON.parse(init.body as string) as {
        content: { parts: Array<{ text: string }> };
      };
      return makeSuccessResponse([textIndex(body.content.parts[0]!.text)]);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      bypassWorker: true,
    });

    const vectors = await backend.embed(texts(2));
    expect(vectors.map((v) => v[0])).toEqual([0, 1]);
    expect(batchCalls).toBe(1);

    const controller = new AbortController();
    controller.abort();
    await expect(
      backend.embed(texts(2), { signal: controller.signal }),
    ).rejects.toThrow("fetch failed");
  });

  test("a batch error whose body cannot be read is re-sent as singles", async () => {
    let batchCalls = 0;
    const fetchMock = mock(async (url: string, init: RequestInit) => {
      if (url.includes(":batchEmbedContents")) {
        batchCalls += 1;
        const stream = new ReadableStream({
          pull(controller) {
            controller.error(new Error("stream reset"));
          },
        });
        return new Response(stream, { status: 502 });
      }
      const body = JSON.parse(init.body as string) as {
        content: { parts: Array<{ text: string }> };
      };
      return makeSuccessResponse([textIndex(body.content.parts[0]!.text)]);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      bypassWorker: true,
    });

    const vectors = await backend.embed(texts(2));

    expect(vectors.map((v) => v[0])).toEqual([0, 1]);
    expect(batchCalls).toBe(1);
    expect(fetchMock.mock.calls).toHaveLength(3);
  });

  test("a batch answered with a body that is not JSON is re-sent as singles", async () => {
    let batchCalls = 0;
    const fetchMock = mock(async (url: string, init: RequestInit) => {
      if (url.includes(":batchEmbedContents")) {
        batchCalls += 1;
        return new Response("<html>gateway timeout</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      const body = JSON.parse(init.body as string) as {
        content: { parts: Array<{ text: string }> };
      };
      return makeSuccessResponse([textIndex(body.content.parts[0]!.text)]);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      bypassWorker: true,
    });

    const vectors = await backend.embed(texts(3));

    expect(vectors.map((v) => v[0])).toEqual([0, 1, 2]);
    expect(batchCalls).toBe(1);
    expect(fetchMock.mock.calls).toHaveLength(4);
  });

  test("a batch body without one vector per input is re-sent as singles", async () => {
    const fetchMock = routedFetch({ body: [{ values: [0] }] });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const backend = new GeminiEmbeddingBackend("test-key", "test-model", {
      bypassWorker: true,
    });

    const vectors = await backend.embed(texts(3));

    expect(vectors.map((v) => v[0])).toEqual([0, 1, 2]);
    expect(fetchMock.mock.calls).toHaveLength(4);
  });
});

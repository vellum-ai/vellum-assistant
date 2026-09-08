import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const createMock = mock(async (_body: unknown, _opts?: unknown) => ({
  data: [{ embedding: [0.1, 0.2, 0.3] }],
}));

let lastCtorArgs: { apiKey?: string; baseURL?: string } | undefined;

mock.module("openai", () => ({
  default: class OpenAI {
    embeddings = { create: createMock };
    constructor(opts: { apiKey: string; baseURL?: string }) {
      lastCtorArgs = opts;
    }
  },
}));

import {
  OpenAIEmbeddingBackend,
  resolveOpenAICompatibleBaseUrl,
} from "./embedding-openai.js";

describe("resolveOpenAICompatibleBaseUrl", () => {
  test("trims and strips a trailing slash", () => {
    expect(
      resolveOpenAICompatibleBaseUrl(" https://gateway.example.com/v1/ "),
    ).toBe("https://gateway.example.com/v1");
  });

  test("accepts http localhost URLs", () => {
    expect(resolveOpenAICompatibleBaseUrl("http://127.0.0.1:4000/v1")).toBe(
      "http://127.0.0.1:4000/v1",
    );
  });

  test("rejects empty, non-http, and invalid values", () => {
    expect(resolveOpenAICompatibleBaseUrl(undefined)).toBeNull();
    expect(resolveOpenAICompatibleBaseUrl("")).toBeNull();
    expect(resolveOpenAICompatibleBaseUrl("   ")).toBeNull();
    expect(resolveOpenAICompatibleBaseUrl("not-a-url")).toBeNull();
    expect(resolveOpenAICompatibleBaseUrl("ftp://gateway.example.com/v1")).toBe(
      null,
    );
  });
});

describe("OpenAIEmbeddingBackend", () => {
  beforeEach(() => {
    createMock.mockClear();
    lastCtorArgs = undefined;
  });

  afterEach(() => {
    createMock.mockClear();
  });

  test("constructs the official OpenAI client without a baseURL", () => {
    const backend = new OpenAIEmbeddingBackend(
      "sk-test",
      "text-embedding-3-small",
    );
    expect(backend.provider).toBe("openai");
    expect(lastCtorArgs).toEqual({ apiKey: "sk-test" });
  });

  test("routes custom embeddings through the supplied baseURL", async () => {
    const backend = new OpenAIEmbeddingBackend("gw-key", "embed-mistral", {
      provider: "custom",
      baseURL: "http://127.0.0.1:4000/v1",
      dimensions: 1024,
    });
    expect(backend.provider).toBe("custom");
    expect(backend.baseURL).toBe("http://127.0.0.1:4000/v1");
    expect(lastCtorArgs).toEqual({
      apiKey: "gw-key",
      baseURL: "http://127.0.0.1:4000/v1",
    });

    const vectors = await backend.embed(["hello"]);
    expect(vectors).toEqual([[0.1, 0.2, 0.3]]);
    expect(createMock).toHaveBeenCalledTimes(1);
    const [body] = createMock.mock.calls[0] as [
      {
        model: string;
        input: string[];
        encoding_format: string;
        dimensions?: number;
      },
    ];
    expect(body.model).toBe("embed-mistral");
    expect(body.input).toEqual(["hello"]);
    expect(body.encoding_format).toBe("float");
    expect(body.dimensions).toBe(1024);
  });

  test("uses a placeholder API key when the custom endpoint is keyless", () => {
    new OpenAIEmbeddingBackend("", "text-embedding-3-small", {
      provider: "custom",
      baseURL: "http://127.0.0.1:1234/v1",
    });
    expect(lastCtorArgs?.apiKey).toBe("not-needed");
  });

  test("omits dimensions when they are not configured", async () => {
    const backend = new OpenAIEmbeddingBackend(
      "sk-test",
      "text-embedding-3-small",
    );
    await backend.embed(["hello"]);
    const [body] = createMock.mock.calls[0] as [{ dimensions?: number }];
    expect(body.dimensions).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";

import {
  MemoryEmbeddingsConfigSchema,
  VALID_MEMORY_EMBEDDING_PROVIDERS,
} from "./memory-storage.js";

describe("MemoryEmbeddingsConfigSchema", () => {
  test("includes custom in the provider enum", () => {
    expect(VALID_MEMORY_EMBEDDING_PROVIDERS).toContain("custom");
  });

  test("accepts a custom OpenAI-compatible endpoint", () => {
    const parsed = MemoryEmbeddingsConfigSchema.parse({
      provider: "custom",
      baseUrl: "https://gateway.example.com/v1",
      customModel: "text-embedding-3-small",
      customDimensions: 1536,
    });
    expect(parsed.provider).toBe("custom");
    expect(parsed.baseUrl).toBe("https://gateway.example.com/v1");
    expect(parsed.customModel).toBe("text-embedding-3-small");
    expect(parsed.customDimensions).toBe(1536);
  });

  test("defaults customModel when it is omitted", () => {
    const parsed = MemoryEmbeddingsConfigSchema.parse({
      provider: "custom",
      baseUrl: "http://127.0.0.1:4000/v1",
    });
    expect(parsed.customModel).toBe("text-embedding-3-small");
  });

  test("rejects an unknown provider", () => {
    expect(() =>
      MemoryEmbeddingsConfigSchema.parse({ provider: "portkey" }),
    ).toThrow(/must be one of/);
  });
});

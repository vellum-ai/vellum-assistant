import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { applyNestedDefaults } from "../config/loader.js";
import type { AssistantConfig } from "../config/types.js";
import { resolveQdrantUrl } from "./qdrant-client.js";

const DEFAULT_CONFIG: AssistantConfig = applyNestedDefaults({});

describe("resolveQdrantUrl", () => {
  const savedPort = process.env.QDRANT_HTTP_PORT;
  const savedUrl = process.env.QDRANT_URL;

  beforeEach(() => {
    delete process.env.QDRANT_HTTP_PORT;
    delete process.env.QDRANT_URL;
  });

  afterEach(() => {
    if (savedPort === undefined) delete process.env.QDRANT_HTTP_PORT;
    else process.env.QDRANT_HTTP_PORT = savedPort;
    if (savedUrl === undefined) delete process.env.QDRANT_URL;
    else process.env.QDRANT_URL = savedUrl;
  });

  test("falls back to config when no env vars are set", () => {
    expect(resolveQdrantUrl(DEFAULT_CONFIG)).toBe("http://127.0.0.1:6333");
  });

  test("honours QDRANT_URL when set", () => {
    process.env.QDRANT_URL = "http://qdrant.example.com:6333";
    expect(resolveQdrantUrl(DEFAULT_CONFIG)).toBe(
      "http://qdrant.example.com:6333",
    );
  });

  test("QDRANT_HTTP_PORT wins over QDRANT_URL", () => {
    process.env.QDRANT_URL = "http://qdrant.example.com:6333";
    process.env.QDRANT_HTTP_PORT = "20200";
    expect(resolveQdrantUrl(DEFAULT_CONFIG)).toBe("http://127.0.0.1:20200");
  });

  test("QDRANT_HTTP_PORT wins over config default", () => {
    process.env.QDRANT_HTTP_PORT = "20200";
    expect(resolveQdrantUrl(DEFAULT_CONFIG)).toBe("http://127.0.0.1:20200");
  });

  test("respects a non-default config URL when no env is set", () => {
    const config: AssistantConfig = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        qdrant: {
          ...DEFAULT_CONFIG.memory.qdrant,
          url: "http://custom-host:9999",
        },
      },
    };
    expect(resolveQdrantUrl(config)).toBe("http://custom-host:9999");
  });
});

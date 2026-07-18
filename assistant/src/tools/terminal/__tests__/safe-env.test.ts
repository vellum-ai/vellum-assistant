import { afterEach, describe, expect, test } from "bun:test";

import { buildSanitizedEnv, SAFE_ENV_VARS } from "../safe-env.js";

describe("safe-env Qdrant forwarding", () => {
  const priorPort = process.env.QDRANT_HTTP_PORT;
  const priorUrl = process.env.QDRANT_URL;

  afterEach(() => {
    if (priorPort == null) {
      delete process.env.QDRANT_HTTP_PORT;
    } else {
      process.env.QDRANT_HTTP_PORT = priorPort;
    }
    if (priorUrl == null) {
      delete process.env.QDRANT_URL;
    } else {
      process.env.QDRANT_URL = priorUrl;
    }
  });

  test("QDRANT_HTTP_PORT is on the allowlist and forwarded to subprocesses", () => {
    expect(SAFE_ENV_VARS).toContain("QDRANT_HTTP_PORT");

    process.env.QDRANT_HTTP_PORT = "6543";
    const env = buildSanitizedEnv();
    expect(env.QDRANT_HTTP_PORT).toBe("6543");
  });

  test("QDRANT_URL is stripped — it would flip QdrantManager to external mode", () => {
    expect(SAFE_ENV_VARS).not.toContain("QDRANT_URL");

    process.env.QDRANT_URL = "http://external:6333";
    const env = buildSanitizedEnv();
    expect(env.QDRANT_URL).toBeUndefined();
  });
});

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
    "silent",
    "child",
  ]) {
    stub[m] = m === "child" ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module("../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

// Configurable config stub. Each test sets `currentConfig` before calling
// the factory. The ClickHouse source is dynamic-imported, so its constructor
// runs lazily; we don't need to mock conversation-crud here because none of
// the factory's tests actually exercise the CH read path.
const LOCAL_DEFAULT_CONFIG = {
  llmRequestLogs: {
    readSource: "local",
    clickhouse: {
      database: "default",
      table: "llm_request_logs",
      user: "default",
    },
  },
};
let currentConfig: unknown = LOCAL_DEFAULT_CONFIG;
mock.module("../config/loader.js", () => ({
  getConfig: () => currentConfig,
}));

// Bun's `mock.module()` persists process-wide; reset to the safe local
// default after this file runs so other test files that touch this module
// (or transitively call `getConfig()` through the factory) don't pick up
// a stale `readSource=clickhouse` value. Also drop the factory's internal
// cache so the next caller resolves fresh against the reset config.
afterAll(() => {
  currentConfig = LOCAL_DEFAULT_CONFIG;
  invalidateLlmRequestLogSourceCache();
});

import {
  getLlmRequestLogSource,
  invalidateLlmRequestLogSourceCache,
} from "../memory/llm-request-log-source.js";
import { ClickHouseLlmRequestLogSource } from "../memory/llm-request-log-source-clickhouse.js";
import { LocalLlmRequestLogSource } from "../memory/llm-request-log-source-local.js";

describe("getLlmRequestLogSource factory", () => {
  beforeEach(() => {
    invalidateLlmRequestLogSourceCache();
  });

  test("returns LocalLlmRequestLogSource when readSource is 'local'", async () => {
    currentConfig = {
      llmRequestLogs: {
        readSource: "local",
        clickhouse: { database: "default", table: "llm_request_logs", user: "default" },
      },
    };
    const src = await getLlmRequestLogSource();
    expect(src).toBeInstanceOf(LocalLlmRequestLogSource);
  });

  test("returns LocalLlmRequestLogSource when llmRequestLogs is undefined (defensive)", async () => {
    currentConfig = {};
    const src = await getLlmRequestLogSource();
    expect(src).toBeInstanceOf(LocalLlmRequestLogSource);
  });

  test("returns ClickHouseLlmRequestLogSource when readSource is 'clickhouse'", async () => {
    currentConfig = {
      llmRequestLogs: {
        readSource: "clickhouse",
        clickhouse: { database: "default", table: "llm_request_logs", user: "default" },
      },
    };
    const src = await getLlmRequestLogSource();
    expect(src).toBeInstanceOf(ClickHouseLlmRequestLogSource);
  });

  test("caches the resolved source across calls", async () => {
    currentConfig = {
      llmRequestLogs: {
        readSource: "local",
        clickhouse: { database: "default", table: "llm_request_logs", user: "default" },
      },
    };
    const first = await getLlmRequestLogSource();
    const second = await getLlmRequestLogSource();
    expect(second).toBe(first);
  });

  test("invalidateLlmRequestLogSourceCache forces a fresh resolution", async () => {
    currentConfig = {
      llmRequestLogs: {
        readSource: "local",
        clickhouse: { database: "default", table: "llm_request_logs", user: "default" },
      },
    };
    const first = await getLlmRequestLogSource();
    invalidateLlmRequestLogSourceCache();
    currentConfig = {
      llmRequestLogs: {
        readSource: "clickhouse",
        clickhouse: { database: "default", table: "llm_request_logs", user: "default" },
      },
    };
    const second = await getLlmRequestLogSource();
    expect(second).not.toBe(first);
    expect(second).toBeInstanceOf(ClickHouseLlmRequestLogSource);
  });
});

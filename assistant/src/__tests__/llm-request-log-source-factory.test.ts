import { afterAll, describe, expect, mock, test } from "bun:test";

// Configurable config stub. Each test sets `currentConfig` before calling
// the factory. The ClickHouse source is dynamic-imported, so its
// constructor runs lazily; we don't need to mock conversation-crud here
// because none of the factory tests exercise the CH read path.
const LOCAL_DEFAULT_CONFIG = { llmRequestLogs: { readSource: "local" } };
let currentConfig: unknown = LOCAL_DEFAULT_CONFIG;
mock.module("../config/loader.js", () => ({
  getConfig: () => currentConfig,
}));

// Bun's `mock.module()` persists process-wide; reset to the safe local
// default after this file runs so other test files that touch this module
// (or transitively call `getConfig()` through the factory) don't pick up
// a stale `readSource=clickhouse` value.
afterAll(() => {
  currentConfig = LOCAL_DEFAULT_CONFIG;
});

import { getLlmRequestLogSource } from "../persistence/llm-request-log-source.js";
import { ClickHouseLlmRequestLogSource } from "../persistence/llm-request-log-source-clickhouse.js";
import { LocalLlmRequestLogSource } from "../persistence/llm-request-log-source-local.js";

describe("getLlmRequestLogSource factory", () => {
  test("returns LocalLlmRequestLogSource when readSource is 'local'", async () => {
    currentConfig = { llmRequestLogs: { readSource: "local" } };
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
        clickhouse: {
          database: "default",
          table: "llm_request_logs",
          user: "default",
        },
      },
    };
    const src = await getLlmRequestLogSource();
    expect(src).toBeInstanceOf(ClickHouseLlmRequestLogSource);
  });

  test("instantiates a fresh source on every call (no module-level cache)", async () => {
    currentConfig = { llmRequestLogs: { readSource: "local" } };
    const first = await getLlmRequestLogSource();
    const second = await getLlmRequestLogSource();
    expect(second).not.toBe(first);
    expect(second).toBeInstanceOf(LocalLlmRequestLogSource);
  });

  test("picks up live config changes without an invalidation hook", async () => {
    currentConfig = { llmRequestLogs: { readSource: "local" } };
    const before = await getLlmRequestLogSource();
    expect(before).toBeInstanceOf(LocalLlmRequestLogSource);

    currentConfig = {
      llmRequestLogs: {
        readSource: "clickhouse",
        clickhouse: {
          database: "default",
          table: "llm_request_logs",
          user: "default",
        },
      },
    };
    const after = await getLlmRequestLogSource();
    expect(after).toBeInstanceOf(ClickHouseLlmRequestLogSource);
  });
});

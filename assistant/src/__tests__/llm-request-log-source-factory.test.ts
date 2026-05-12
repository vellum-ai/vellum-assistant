import { beforeEach, describe, expect, mock, test } from "bun:test";

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

// Stub the SQLite-backed helpers used by the ClickHouse source so the
// factory test doesn't need a real database.
mock.module("../memory/conversation-crud.js", () => ({
  getAssistantMessageIdsInTurn: () => [] as string[],
  getMessageById: () => null,
  messageMetadataSchema: { safeParse: () => ({ success: false }) },
}));

// Configurable config stub. Each test sets `currentConfig` before calling
// the factory.
let currentConfig: unknown = { llmRequestLogs: { readSource: "local", clickhouse: { database: "default", table: "llm_request_logs", user: "default" } } };
mock.module("../config/loader.js", () => ({
  getConfig: () => currentConfig,
}));

import { ClickHouseLlmRequestLogSource } from "../memory/llm-request-log-source-clickhouse.js";
import { LocalLlmRequestLogSource } from "../memory/llm-request-log-source-local.js";
import {
  getLlmRequestLogSource,
  invalidateLlmRequestLogSourceCache,
} from "../memory/llm-request-log-source.js";

describe("getLlmRequestLogSource factory", () => {
  beforeEach(() => {
    invalidateLlmRequestLogSourceCache();
  });

  test("returns LocalLlmRequestLogSource when readSource is 'local'", () => {
    currentConfig = {
      llmRequestLogs: {
        readSource: "local",
        clickhouse: { database: "default", table: "llm_request_logs", user: "default" },
      },
    };
    const src = getLlmRequestLogSource();
    expect(src).toBeInstanceOf(LocalLlmRequestLogSource);
  });

  test("returns LocalLlmRequestLogSource when llmRequestLogs is undefined (defensive)", () => {
    currentConfig = {};
    const src = getLlmRequestLogSource();
    expect(src).toBeInstanceOf(LocalLlmRequestLogSource);
  });

  test("returns ClickHouseLlmRequestLogSource when readSource is 'clickhouse'", () => {
    currentConfig = {
      llmRequestLogs: {
        readSource: "clickhouse",
        clickhouse: { database: "default", table: "llm_request_logs", user: "default" },
      },
    };
    const src = getLlmRequestLogSource();
    expect(src).toBeInstanceOf(ClickHouseLlmRequestLogSource);
  });

  test("caches the resolved source across calls", () => {
    currentConfig = {
      llmRequestLogs: {
        readSource: "local",
        clickhouse: { database: "default", table: "llm_request_logs", user: "default" },
      },
    };
    const first = getLlmRequestLogSource();
    const second = getLlmRequestLogSource();
    expect(second).toBe(first);
  });

  test("invalidateLlmRequestLogSourceCache forces a fresh resolution", () => {
    currentConfig = {
      llmRequestLogs: {
        readSource: "local",
        clickhouse: { database: "default", table: "llm_request_logs", user: "default" },
      },
    };
    const first = getLlmRequestLogSource();
    invalidateLlmRequestLogSourceCache();
    currentConfig = {
      llmRequestLogs: {
        readSource: "clickhouse",
        clickhouse: { database: "default", table: "llm_request_logs", user: "default" },
      },
    };
    const second = getLlmRequestLogSource();
    expect(second).not.toBe(first);
    expect(second).toBeInstanceOf(ClickHouseLlmRequestLogSource);
  });
});

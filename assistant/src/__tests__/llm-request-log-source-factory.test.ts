import { describe, expect, test } from "bun:test";

import { getLlmRequestLogSource } from "../persistence/llm-request-log-source.js";
import { ClickHouseLlmRequestLogSource } from "../persistence/llm-request-log-source-clickhouse.js";
import { LocalLlmRequestLogSource } from "../persistence/llm-request-log-source-local.js";
import { setConfig } from "./helpers/set-config.js";

// Each test seeds `llmRequestLogs` into the workspace config for real before
// calling the factory. The ClickHouse source is dynamic-imported, so its
// constructor runs lazily; none of the factory tests exercise the CH read
// path.
const CLICKHOUSE_CONFIG = {
  database: "default",
  table: "llm_request_logs",
  user: "default",
};

describe("getLlmRequestLogSource factory", () => {
  test("returns LocalLlmRequestLogSource when readSource is 'local'", async () => {
    setConfig("llmRequestLogs", { readSource: "local" });
    const src = await getLlmRequestLogSource();
    expect(src).toBeInstanceOf(LocalLlmRequestLogSource);
  });

  test("returns ClickHouseLlmRequestLogSource when readSource is 'clickhouse'", async () => {
    setConfig("llmRequestLogs", {
      readSource: "clickhouse",
      clickhouse: CLICKHOUSE_CONFIG,
    });
    const src = await getLlmRequestLogSource();
    expect(src).toBeInstanceOf(ClickHouseLlmRequestLogSource);
  });

  test("instantiates a fresh source on every call (no module-level cache)", async () => {
    setConfig("llmRequestLogs", { readSource: "local" });
    const first = await getLlmRequestLogSource();
    const second = await getLlmRequestLogSource();
    expect(second).not.toBe(first);
    expect(second).toBeInstanceOf(LocalLlmRequestLogSource);
  });

  test("picks up live config changes without an invalidation hook", async () => {
    setConfig("llmRequestLogs", { readSource: "local" });
    const before = await getLlmRequestLogSource();
    expect(before).toBeInstanceOf(LocalLlmRequestLogSource);

    setConfig("llmRequestLogs", {
      readSource: "clickhouse",
      clickhouse: CLICKHOUSE_CONFIG,
    });
    const after = await getLlmRequestLogSource();
    expect(after).toBeInstanceOf(ClickHouseLlmRequestLogSource);
  });
});

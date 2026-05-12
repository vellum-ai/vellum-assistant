import { describe, expect, test } from "bun:test";

import { LlmRequestLogsConfigSchema } from "../llm-request-logs.js";

describe("LlmRequestLogsConfigSchema", () => {
  test("parses undefined to the local default", () => {
    expect(LlmRequestLogsConfigSchema.parse(undefined)).toEqual({
      readSource: "local",
    });
  });

  test("parses an explicit local readSource", () => {
    expect(
      LlmRequestLogsConfigSchema.parse({ readSource: "local" }),
    ).toEqual({ readSource: "local" });
  });

  test("parses an explicit clickhouse readSource with defaulted connection fields", () => {
    expect(
      LlmRequestLogsConfigSchema.parse({ readSource: "clickhouse" }),
    ).toEqual({
      readSource: "clickhouse",
      clickhouse: {
        database: "default",
        table: "llm_request_logs",
        user: "default",
      },
    });
  });

  test("rejects an unknown readSource", () => {
    expect(() =>
      LlmRequestLogsConfigSchema.parse({ readSource: "postgres" }),
    ).toThrow();
  });
});

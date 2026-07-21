import { describe, expect, test } from "bun:test";

import { LlmRequestLogsConfigSchema } from "../llm-request-logs.js";

describe("LlmRequestLogsConfigSchema", () => {
  test("parses undefined to the local default with logging enabled", () => {
    expect(LlmRequestLogsConfigSchema.parse(undefined)).toEqual({
      readSource: "local",
      enabled: true,
    });
  });

  test("parses an explicit local readSource with logging enabled by default", () => {
    expect(LlmRequestLogsConfigSchema.parse({ readSource: "local" })).toEqual({
      readSource: "local",
      enabled: true,
    });
  });

  test("parses an explicit clickhouse readSource with defaulted connection fields", () => {
    expect(
      LlmRequestLogsConfigSchema.parse({ readSource: "clickhouse" }),
    ).toEqual({
      readSource: "clickhouse",
      enabled: true,
      clickhouse: {
        database: "default",
        table: "llm_request_logs",
        user: "default",
      },
    });
  });

  test("carries an explicit enabled flag on the local branch", () => {
    expect(
      LlmRequestLogsConfigSchema.parse({ readSource: "local", enabled: false }),
    ).toEqual({ readSource: "local", enabled: false });
  });

  test("defaults a missing readSource to local so an enabled-only write still parses", () => {
    // `config set llmRequestLogs.enabled false` writes `{ enabled: false }`
    // with no discriminator; it must parse (on the local branch) rather than
    // collapse the whole config to defaults via leaf-deletion recovery.
    expect(LlmRequestLogsConfigSchema.parse({ enabled: false })).toEqual({
      readSource: "local",
      enabled: false,
    });
  });

  test("rejects a non-boolean enabled flag", () => {
    expect(() =>
      LlmRequestLogsConfigSchema.parse({
        readSource: "local",
        enabled: "yes",
      }),
    ).toThrow();
  });

  test("rejects an unknown readSource", () => {
    expect(() =>
      LlmRequestLogsConfigSchema.parse({ readSource: "postgres" }),
    ).toThrow();
  });
});

import { describe, expect, test } from "bun:test";

import { LlmRequestLogsConfigSchema } from "../llm-request-logs.js";

describe("LlmRequestLogsConfigSchema", () => {
  test("parses undefined to the local default with logging enabled", () => {
    expect(LlmRequestLogsConfigSchema.parse(undefined)).toEqual({
      readSource: "local",
      disabled: false,
    });
  });

  test("parses an explicit local readSource with logging enabled by default", () => {
    expect(LlmRequestLogsConfigSchema.parse({ readSource: "local" })).toEqual({
      readSource: "local",
      disabled: false,
    });
  });

  test("parses an explicit clickhouse readSource with defaulted connection fields", () => {
    expect(
      LlmRequestLogsConfigSchema.parse({ readSource: "clickhouse" }),
    ).toEqual({
      readSource: "clickhouse",
      disabled: false,
      clickhouse: {
        database: "default",
        table: "llm_request_logs",
        user: "default",
      },
    });
  });

  test("carries an explicit disabled flag on the local branch", () => {
    expect(
      LlmRequestLogsConfigSchema.parse({ readSource: "local", disabled: true }),
    ).toEqual({ readSource: "local", disabled: true });
  });

  test("defaults a missing readSource to local so a disabled-only write still parses", () => {
    // `config set llmRequestLogs.disabled true` writes `{ disabled: true }`
    // with no discriminator; it must parse (on the local branch) rather than
    // collapse the whole config to defaults via leaf-deletion recovery.
    expect(LlmRequestLogsConfigSchema.parse({ disabled: true })).toEqual({
      readSource: "local",
      disabled: true,
    });
  });

  test("rejects a non-boolean disabled flag", () => {
    expect(() =>
      LlmRequestLogsConfigSchema.parse({
        readSource: "local",
        disabled: "yes",
      }),
    ).toThrow();
  });

  test("rejects an unknown readSource", () => {
    expect(() =>
      LlmRequestLogsConfigSchema.parse({ readSource: "postgres" }),
    ).toThrow();
  });
});

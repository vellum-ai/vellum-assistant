import { describe, expect, test } from "bun:test";

import { CompactionLogsConfigSchema } from "../compaction-logs.js";

describe("CompactionLogsConfigSchema", () => {
  test("parses undefined to the disabled default", () => {
    expect(CompactionLogsConfigSchema.parse(undefined)).toEqual({
      destination: "none",
    });
  });

  test("parses an explicit none destination", () => {
    expect(CompactionLogsConfigSchema.parse({ destination: "none" })).toEqual({
      destination: "none",
    });
  });

  test("parses an explicit clickhouse destination with defaulted connection fields", () => {
    expect(
      CompactionLogsConfigSchema.parse({ destination: "clickhouse" }),
    ).toEqual({
      destination: "clickhouse",
      clickhouse: {
        database: "default",
        table: "compaction_logs",
        user: "default",
      },
    });
  });

  test("parses explicit clickhouse connection overrides", () => {
    expect(
      CompactionLogsConfigSchema.parse({
        destination: "clickhouse",
        clickhouse: {
          database: "analytics",
          table: "compactions",
          user: "writer",
        },
      }),
    ).toEqual({
      destination: "clickhouse",
      clickhouse: {
        database: "analytics",
        table: "compactions",
        user: "writer",
      },
    });
  });

  test("rejects an unknown destination", () => {
    expect(() =>
      CompactionLogsConfigSchema.parse({ destination: "sqlite" }),
    ).toThrow();
  });
});

/**
 * Configuration for the compaction log destination.
 *
 * Compaction logging is **off by default** (`destination: "none"`). An
 * assistant can opt into a ClickHouse-only destination; there is no SQLite
 * destination — compaction events are derived from the agent loop's
 * compaction start/end events and written straight to ClickHouse.
 *
 * When `destination === "clickhouse"` the URL and password are resolved
 * from the credential store (`clickhouse:url`, `clickhouse:password`),
 * matching the `llmRequestLogs.clickhouse` convention. The connection
 * options below describe everything else (database/table/user).
 *
 * The shape is a discriminated union on `destination` so the `clickhouse`
 * block only exists on the ClickHouse branch — there's no stray defaults
 * sitting around when logging is disabled.
 */
import { z } from "zod";

export const CompactionLogsClickHouseConfigSchema = z
  .object({
    database: z
      .string({ error: "compactionLogs.clickhouse.database must be a string" })
      .min(1, "compactionLogs.clickhouse.database cannot be empty")
      .default("default")
      .describe("ClickHouse database containing the compaction logs table"),
    table: z
      .string({ error: "compactionLogs.clickhouse.table must be a string" })
      .min(1, "compactionLogs.clickhouse.table cannot be empty")
      .default("compaction_logs")
      .describe("ClickHouse table name to write compaction logs to"),
    user: z
      .string({ error: "compactionLogs.clickhouse.user must be a string" })
      .min(1, "compactionLogs.clickhouse.user cannot be empty")
      .default("default")
      .describe("ClickHouse user (password is read from credential store)"),
  })
  .describe(
    "ClickHouse connection settings used when `destination` is `clickhouse`",
  );

const NoneCompactionLogsConfigSchema = z
  .object({
    destination: z.literal("none"),
  })
  .describe("Compaction logging disabled (default).");

const ClickHouseCompactionLogsConfigSchema = z
  .object({
    destination: z.literal("clickhouse"),
    clickhouse: CompactionLogsClickHouseConfigSchema.default(
      CompactionLogsClickHouseConfigSchema.parse({}),
    ),
  })
  .describe(
    "Write compaction logs to ClickHouse. Requires the `clickhouse:url` and `clickhouse:password` credentials to be set.",
  );

// The default is baked into the export so the schema matches the sibling
// pattern across `assistant/src/config/schemas/*` — `Schema.parse(undefined)`
// returns documented defaults. The discriminated union has no inherent
// default (no shared discriminator value), so we explicitly select the
// `none` branch.
//
// Note: `CompactionLogsConfigSchema.parse({})` still throws — a discriminated
// union cannot pick a branch without a discriminator. Use `parse(undefined)`
// or omit the field entirely to get the default.
export const CompactionLogsConfigSchema = z
  .discriminatedUnion("destination", [
    NoneCompactionLogsConfigSchema,
    ClickHouseCompactionLogsConfigSchema,
  ])
  .default({ destination: "none" })
  .describe("Compaction log destination configuration");

export type CompactionLogsConfig = z.infer<typeof CompactionLogsConfigSchema>;
export type CompactionLogsClickHouseConfig = z.infer<
  typeof CompactionLogsClickHouseConfigSchema
>;

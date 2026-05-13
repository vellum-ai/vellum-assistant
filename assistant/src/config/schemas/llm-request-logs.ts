/**
 * Configuration for LLM request log read source.
 *
 * Writes always land in the local SQLite `llm_request_logs` table; reads
 * can be switched between local and ClickHouse via `readSource`.
 *
 * When `readSource === "clickhouse"` the URL and password are resolved
 * from the credential store (`clickhouse:url`, `clickhouse:password`).
 * The connection options below describe everything else (database/table/user).
 *
 * The shape is a discriminated union on `readSource` so the `clickhouse`
 * block only exists on the ClickHouse branch — there's no stray defaults
 * sitting around when the source is local.
 *
 * Note: the existing retention setting lives under
 * `memory.cleanup.llmRequestLogRetentionMs` and is independent of this block.
 * That covers when local rows get pruned; this block governs where reads
 * are served from.
 */
import { z } from "zod";

export const LlmRequestLogsClickHouseConfigSchema = z
  .object({
    database: z
      .string({ error: "llmRequestLogs.clickhouse.database must be a string" })
      .min(1, "llmRequestLogs.clickhouse.database cannot be empty")
      .default("default")
      .describe("ClickHouse database containing the llm_request_logs table"),
    table: z
      .string({ error: "llmRequestLogs.clickhouse.table must be a string" })
      .min(1, "llmRequestLogs.clickhouse.table cannot be empty")
      .default("llm_request_logs")
      .describe("ClickHouse table name to read from"),
    user: z
      .string({ error: "llmRequestLogs.clickhouse.user must be a string" })
      .min(1, "llmRequestLogs.clickhouse.user cannot be empty")
      .default("default")
      .describe("ClickHouse user (password is read from credential store)"),
  })
  .describe(
    "ClickHouse connection settings used when `readSource` is `clickhouse`",
  );

const LocalLlmRequestLogsConfigSchema = z
  .object({
    readSource: z.literal("local"),
  })
  .describe("Read LLM request logs from local SQLite (default).");

const ClickHouseLlmRequestLogsConfigSchema = z
  .object({
    readSource: z.literal("clickhouse"),
    clickhouse: LlmRequestLogsClickHouseConfigSchema.default(
      LlmRequestLogsClickHouseConfigSchema.parse({}),
    ),
  })
  .describe(
    "Read LLM request logs from the ClickHouse mirror. Requires the `clickhouse:url` and `clickhouse:password` credentials to be set.",
  );

// The default is baked into the export so the schema matches the sibling
// pattern across `assistant/src/config/schemas/*` — `Schema.parse(undefined)`
// returns documented defaults. The discriminated union has no inherent
// default (no shared discriminator value), so we explicitly select the
// `local` branch.
//
// Note: `LlmRequestLogsConfigSchema.parse({})` still throws — a discriminated
// union cannot pick a branch without a discriminator. Use `parse(undefined)`
// or omit the field entirely to get the default.
export const LlmRequestLogsConfigSchema = z
  .discriminatedUnion("readSource", [
    LocalLlmRequestLogsConfigSchema,
    ClickHouseLlmRequestLogsConfigSchema,
  ])
  .default({ readSource: "local" })
  .describe("LLM request log read source configuration");

export type LlmRequestLogsConfig = z.infer<typeof LlmRequestLogsConfigSchema>;
export type LlmRequestLogsClickHouseConfig = z.infer<
  typeof LlmRequestLogsClickHouseConfigSchema
>;

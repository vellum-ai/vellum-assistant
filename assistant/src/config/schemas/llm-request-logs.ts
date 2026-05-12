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

export const LlmRequestLogsConfigSchema = z
  .object({
    readSource: z
      .enum(["local", "clickhouse"])
      .default("local")
      .describe(
        "Where to read LLM request logs from for Inspector queries. `local` reads the SQLite source-of-truth (default, lowest latency). `clickhouse` reads the mirror, which retains data longer than local but only sees writes that the mirror job has flushed.",
      ),
    clickhouse: LlmRequestLogsClickHouseConfigSchema.default(
      LlmRequestLogsClickHouseConfigSchema.parse({}),
    ),
  })
  .describe("LLM request log read source configuration");

export type LlmRequestLogsConfig = z.infer<typeof LlmRequestLogsConfigSchema>;
export type LlmRequestLogsClickHouseConfig = z.infer<
  typeof LlmRequestLogsClickHouseConfigSchema
>;

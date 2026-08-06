/**
 * Configuration for LLM request logging.
 *
 * Two independent concerns live here:
 *
 * 1. `enabled` — the master switch. When `false`, the daemon skips every
 *    `llm_request_logs` write and the inspector read routes return a 4xx
 *    (`LLM_REQUEST_LOGS_DISABLED`) instead of serving rows. Defaults to
 *    `true` (logging on). Existing rows are left untouched — this is a
 *    write/read gate, not a delete.
 *
 * 2. `readSource` — where reads are served from. Writes land in the local
 *    SQLite `llm_request_logs` table; reads can be switched between local
 *    and ClickHouse via `readSource`.
 *
 * When `readSource === "clickhouse"` the URL and password are resolved
 * from the credential store (`clickhouse:url`, `clickhouse:password`).
 * The connection options below describe everything else (database/table/user).
 *
 * The shape is a discriminated union on `readSource` so the `clickhouse`
 * block only exists on the ClickHouse branch — there's no stray defaults
 * sitting around when the source is local. Both branches extend a shared
 * base (`LlmRequestLogsBaseSchema`) that carries the source-independent
 * fields, and a `preprocess` step defaults a missing `readSource` to
 * `"local"` so a partial write (e.g. `config set llmRequestLogs.enabled
 * false`, which never mentions `readSource`) still parses instead of
 * collapsing the whole config to defaults on the next load.
 *
 * Note: the existing retention setting lives under
 * `memory.cleanup.llmRequestLogRetentionMs` and is independent of this block.
 * That covers when local rows get pruned; this block governs whether logging
 * happens at all and where reads are served from.
 */
import { z } from "zod";

/**
 * Source-independent fields shared by both read-source branches. Kept as a
 * base object the discriminated-union branches `.extend()` so a field like
 * `enabled` is declared once and lives at a stable top-level path
 * (`llmRequestLogs.enabled`) regardless of `readSource`.
 */
const LlmRequestLogsBaseSchema = z.object({
  enabled: z
    .boolean({ error: "llmRequestLogs.enabled must be a boolean" })
    .default(true)
    .describe(
      "Master switch for LLM request logging. When false, skip all writes " +
        "and return a 4xx from inspector read routes. Existing rows are not " +
        "deleted.",
    ),
});

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

const LocalLlmRequestLogsConfigSchema = LlmRequestLogsBaseSchema.extend({
  readSource: z.literal("local"),
}).describe("Read LLM request logs from local SQLite (default).");

const ClickHouseLlmRequestLogsConfigSchema = LlmRequestLogsBaseSchema.extend({
  readSource: z.literal("clickhouse"),
  clickhouse: LlmRequestLogsClickHouseConfigSchema.default(
    LlmRequestLogsClickHouseConfigSchema.parse({}),
  ),
}).describe(
  "Read LLM request logs from the ClickHouse mirror. Requires the `clickhouse:url` and `clickhouse:password` credentials to be set.",
);

/**
 * Inject `readSource: "local"` when a caller supplies an object without it.
 * A discriminated union cannot pick a branch without its discriminator, so a
 * partial write like `{ enabled: false }` (from `config set
 * llmRequestLogs.enabled false`) would otherwise fail to parse and — via the
 * loader's leaf-deletion recovery — take the whole config down to defaults.
 * Defaulting the discriminator keeps such writes on the `local` branch while
 * preserving any sibling fields (e.g. `enabled`).
 */
function defaultReadSourceToLocal(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !("readSource" in value)
  ) {
    return { readSource: "local", ...value };
  }
  return value;
}

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
  .preprocess(
    defaultReadSourceToLocal,
    z.discriminatedUnion("readSource", [
      LocalLlmRequestLogsConfigSchema,
      ClickHouseLlmRequestLogsConfigSchema,
    ]),
  )
  .default({ readSource: "local", enabled: true })
  .describe("LLM request logging configuration");

export type LlmRequestLogsConfig = z.infer<typeof LlmRequestLogsConfigSchema>;
export type LlmRequestLogsClickHouseConfig = z.infer<
  typeof LlmRequestLogsClickHouseConfigSchema
>;

import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

const TABLE = "llm_usage_events";
const COLUMN = "raw_usage";

/**
 * Add a `raw_usage` TEXT column to `llm_usage_events` for storing the
 * provider's untouched `usage` block as JSON.
 *
 * The Anthropic API surfaces a TTL breakdown of cache writes
 * (`usage.cache_creation.ephemeral_5m_input_tokens`,
 * `usage.cache_creation.ephemeral_1h_input_tokens`); OpenAI surfaces
 * nested `prompt_tokens_details` and `completion_tokens_details`; both
 * are kept as opaque JSON so admin charts and downstream consumers can
 * extract provider-specific detail without requiring a new column every
 * time a provider adds a usage field. `NULL` for rows persisted before
 * this migration ran and for providers that did not return a usage
 * payload.
 */
export function migrateLlmUsageAddRawUsage(database: DrizzleDb): void {
  if (!tableHasColumn(database, TABLE, COLUMN)) {
    database.run(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} TEXT`);
  }
}

export function downLlmUsageAddRawUsage(database: DrizzleDb): void {
  if (tableHasColumn(database, TABLE, COLUMN)) {
    database.run(`ALTER TABLE ${TABLE} DROP COLUMN ${COLUMN}`);
  }
}

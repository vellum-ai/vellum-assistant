import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Add stable attribution identifiers to the local LLM usage ledger.
 *
 * Existing rows remain valid with NULL attribution. Provider/model continue to
 * represent the resolved provider/model used for the request.
 */
export function migrateLlmUsageAttribution(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  if (!tableHasColumn(database, "llm_usage_events", "call_site")) {
    raw.exec(/*sql*/ `ALTER TABLE llm_usage_events ADD COLUMN call_site TEXT`);
  }

  if (!tableHasColumn(database, "llm_usage_events", "inference_profile")) {
    raw.exec(
      /*sql*/ `ALTER TABLE llm_usage_events ADD COLUMN inference_profile TEXT`,
    );
  }

  if (
    !tableHasColumn(database, "llm_usage_events", "inference_profile_source")
  ) {
    raw.exec(
      /*sql*/ `ALTER TABLE llm_usage_events ADD COLUMN inference_profile_source TEXT`,
    );
  }
}

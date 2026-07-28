import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Add matched_trust_rule_id column to tool_invocations for audit and rule editor UI.
 */
export function migrateToolInvocationsMatchedRuleId(database: DrizzleDb): void {
  if (tableHasColumn(database, "tool_invocations", "matched_trust_rule_id")) {
    return;
  }
  database.run(
    `ALTER TABLE tool_invocations ADD COLUMN matched_trust_rule_id TEXT`,
  );
}

export function downToolInvocationsMatchedRuleId(database: DrizzleDb): void {
  if (!tableHasColumn(database, "tool_invocations", "matched_trust_rule_id")) {
    return;
  }
  database.run(
    `ALTER TABLE tool_invocations DROP COLUMN matched_trust_rule_id`,
  );
}

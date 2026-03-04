import type { DrizzleDb } from "../db-connection.js";
import { migrateJobDeferrals } from "./001-job-deferrals.js";
import { migrateToolInvocationsFk } from "./002-tool-invocations-fk.js";
import { migrateMemoryEntityRelationDedup } from "./004-entity-relation-dedup.js";
import { migrateMemoryItemsFingerprintScopeUnique } from "./005-fingerprint-scope-unique.js";
import { migrateMemoryItemsScopeSaltedFingerprints } from "./006-scope-salted-fingerprints.js";
import { migrateAssistantIdToSelf } from "./007-assistant-id-to-self.js";
import { migrateRemoveAssistantIdColumns } from "./008-remove-assistant-id-columns.js";
import { migrateLlmUsageEventsDropAssistantId } from "./009-llm-usage-events-drop-assistant-id.js";

/**
 * Complex multi-step migrations that go beyond simple ALTER TABLE.
 */
export function runComplexMigrations(database: DrizzleDb): void {
  migrateJobDeferrals(database);
  migrateToolInvocationsFk(database);
  migrateMemoryEntityRelationDedup(database);
  migrateMemoryItemsFingerprintScopeUnique(database);
  migrateMemoryItemsScopeSaltedFingerprints(database);
  migrateAssistantIdToSelf(database);
  migrateRemoveAssistantIdColumns(database);
  migrateLlmUsageEventsDropAssistantId(database);
}

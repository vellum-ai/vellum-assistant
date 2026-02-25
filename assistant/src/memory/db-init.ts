import { getDb } from './db-connection.js';
import {
  addCoreColumns,
  createAssistantInboxTables,
  createCallSessionsTables,
  createChannelGuardianTables,
  createContactsAndTriageTables,
  createCoreIndexes,
  createCoreTables,
  createExternalConversationBindingsTables,
  createFollowupsTables,
  createMediaAssetsTables,
  createMessagesFts,
  createNotificationTables,
  createSequenceTables,
  createTasksAndWorkItemsTables,
  createWatchersAndLogsTables,
  migrateCallSessionMode,
  migrateGuardianBootstrapToken,
  migrateGuardianVerificationSessions,
  migrateMessagesFtsBackfill,
  runComplexMigrations,
  runLateMigrations,
  validateMigrationState,
} from './migrations/index.js';

export function initializeDb(): void {
  const database = getDb();

  // 1. Create core tables (conversations, messages, memory, etc.)
  createCoreTables(database);

  // 2. Create watchers, logs, entities, FTS, and conversation keys
  createWatchersAndLogsTables(database);

  // 3. ALTER TABLE ADD COLUMN migrations for core tables
  addCoreColumns(database);

  // 4. Complex multi-step migrations (dedup, FK fixes, assistant_id normalization)
  runComplexMigrations(database);

  // 5. Indexes for core tables + attachment dedup
  createCoreIndexes(database);

  // 6. Contacts and triage
  createContactsAndTriageTables(database);

  // 7. Call sessions (outgoing AI phone calls)
  createCallSessionsTables(database);

  // 7b. Call session mode/metadata for deterministic flow selection
  migrateCallSessionMode(database);

  // 8. Follow-ups
  createFollowupsTables(database);

  // 9. Tasks and work items
  createTasksAndWorkItemsTables(database);

  // 10. External conversation bindings
  createExternalConversationBindingsTables(database);

  // 11. Channel guardian
  createChannelGuardianTables(database);

  // 11b. Guardian verification session columns (outbound identity binding)
  migrateGuardianVerificationSessions(database);

  // 11c. Guardian bootstrap token hash column (Telegram deep-link flow)
  migrateGuardianBootstrapToken(database);

  // 12. Media assets
  createMediaAssetsTables(database);

  // 13. Assistant inbox
  createAssistantInboxTables(database);

  // 14. Late-stage migrations (guardian actions, FTS backfill, index migrations)
  runLateMigrations(database);

  // 15. Notification system
  createNotificationTables(database);

  // 16. Sequences (multi-step outreach)
  createSequenceTables(database);

  // 17. Messages FTS (full-text search over message content)
  createMessagesFts(database);
  migrateMessagesFtsBackfill(database);

  validateMigrationState(database);
}

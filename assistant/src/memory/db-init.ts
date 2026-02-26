import { getDb } from './db-connection.js';
import {
  addCoreColumns,
  createAssistantInboxTables,
  createCallSessionsTables,
  createChannelGuardianTables,
  createContactsAndTriageTables,
  createConversationAttentionTables,
  createCoreIndexes,
  createCoreTables,
  createScopedApprovalGrantsTable,
  createExternalConversationBindingsTables,
  createFollowupsTables,
  createMediaAssetsTables,
  createMessagesFts,
  createNotificationTables,
  createSequenceTables,
  createTasksAndWorkItemsTables,
  createWatchersAndLogsTables,
  migrateCallSessionMode,
  migrateFkCascadeRebuilds,
  migrateChannelInboundDeliveredSegments,
  migrateConversationsThreadTypeIndex,
  migrateGuardianActionFollowup,
  migrateGuardianActionToolMetadata,
  migrateGuardianDeliveryConversationIndex,
  migrateGuardianBootstrapToken,
  migrateGuardianVerificationPurpose,
  migrateGuardianVerificationSessions,
  migrateMessagesFtsBackfill,
  migrateReminderRoutingIntent,
  migrateSchemaIndexesAndColumns,
  recoverCrashedMigrations,
  runComplexMigrations,
  runLateMigrations,
  validateMigrationState,
} from './migrations/index.js';

export function initializeDb(): void {
  const database = getDb();

  // 1. Create core tables (conversations, messages, memory, etc.)
  createCoreTables(database);

  // 1b. Clear any stalled 'started' checkpoints left by previous crashes
  // so the affected migrations can re-run from scratch.
  recoverCrashedMigrations(database);

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

  // 11d. Guardian verification purpose discriminator (guardian vs trusted_contact)
  migrateGuardianVerificationPurpose(database);

  // 12. Media assets
  createMediaAssetsTables(database);

  // 13. Assistant inbox
  createAssistantInboxTables(database);

  // 14. Late-stage migrations (guardian actions, FTS backfill, index migrations)
  runLateMigrations(database);

  // 14b. Track per-segment delivery progress for split channel replies
  migrateChannelInboundDeliveredSegments(database);

  // 14c. Guardian action follow-up lifecycle columns (timeout reason, late answers)
  migrateGuardianActionFollowup(database);

  // 14c2. Guardian action tool-approval metadata columns (tool_name, input_digest)
  migrateGuardianActionToolMetadata(database);

  // 14d. Index on conversations.thread_type for frequent WHERE filters
  migrateConversationsThreadTypeIndex(database);

  // 14e. Index on guardian_action_deliveries.destination_conversation_id for conversation-based lookups
  migrateGuardianDeliveryConversationIndex(database);

  // 15. Notification system
  createNotificationTables(database);

  // 16. Sequences (multi-step outreach)
  createSequenceTables(database);

  // 17. Messages FTS (full-text search over message content)
  createMessagesFts(database);
  migrateMessagesFtsBackfill(database);

  // 18. Conversation attention (seen-state tracking)
  createConversationAttentionTables(database);

  // 19. Reminder routing metadata (routing_intent + routing_hints_json columns)
  migrateReminderRoutingIntent(database);

  // 20. Schema indexes, columns, and constraints
  migrateSchemaIndexesAndColumns(database);

  // 21. Rebuild tables to add ON DELETE CASCADE to FK constraints
  migrateFkCascadeRebuilds(database);

  // 22. Scoped approval grants (channel-agnostic one-time-use grants)
  createScopedApprovalGrantsTable(database);

  validateMigrationState(database);
}

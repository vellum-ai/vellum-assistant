import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ensureDataDir, getDbPath } from "../util/platform.js";
import { getDb, getSqlite } from "./db-connection.js";
import {
  addCoreColumns,
  createActorRefreshTokenRecordsTable,
  createActorTokenRecordsTable,
  createAssistantInboxTables,
  createCallSessionsTables,
  createCanonicalGuardianTables,
  createChannelGuardianTables,
  createContactsAndTriageTables,
  createConversationAttentionTables,
  createCoreIndexes,
  createCoreTables,
  createExternalConversationBindingsTables,
  createFollowupsTables,
  createLifecycleEventsTable,
  createMediaAssetsTables,
  createMessagesFts,
  createNotificationTables,
  createOAuthTables,
  createScopedApprovalGrantsTable,
  createSequenceTables,
  createTasksAndWorkItemsTables,
  createWatchersAndLogsTables,
  migrateAssistantContactMetadata,
  migrateBackfillContactInteractionStats,
  migrateBackfillGuardianPrincipalId,
  migrateBackfillInlineAttachmentsToDisk,
  migrateBackfillUsageCacheAccounting,
  migrateCallSessionInviteMetadata,
  migrateCallSessionMode,
  migrateCanonicalGuardianDeliveriesDestinationIndex,
  migrateCanonicalGuardianRequesterChatId,
  migrateCapabilityCardColumns,
  migrateChannelInboundDeliveredSegments,
  migrateChannelInteractionColumns,
  migrateContactChannelsAccessFields,
  migrateContactChannelsTypeChatIdIndex,
  migrateContactsAssistantId,
  migrateContactsNotesColumn,
  migrateContactsRolePrincipal,
  migrateConversationForkLineage,
  migrateConversationsThreadTypeIndex,
  migrateCreateThreadStartersTable,
  migrateCreateTraceEventsTable,
  migrateDropAccountsTable,
  migrateDropAssistantIdColumns,
  migrateDropCapabilityCardState,
  migrateDropConflicts,
  migrateDropContactInteractionColumns,
  migrateDropEntityTables,
  migrateDropLegacyMemberGuardianTables,
  migrateDropLoopbackPortColumn,
  migrateDropMemorySegmentFts,
  migrateDropOrphanedMediaTables,
  migrateDropRemindersTable,
  migrateDropUsageCompositeIndexes,
  migrateFkCascadeRebuilds,
  migrateGuardianActionFollowup,
  migrateGuardianActionSupersession,
  migrateGuardianActionToolMetadata,
  migrateGuardianBootstrapToken,
  migrateGuardianDeliveryConversationIndex,
  migrateGuardianPrincipalIdColumns,
  migrateGuardianPrincipalIdNotNull,
  migrateGuardianTimestampsEpochMs,
  migrateGuardianVerificationPurpose,
  migrateGuardianVerificationSessions,
  migrateInviteCodeHashColumn,
  migrateInviteContactId,
  migrateLlmRequestLogMessageId,
  migrateLlmRequestLogProvider,
  migrateMemoryArchiveTables,
  migrateMemoryBriefState,
  migrateMemoryItemSupersession,
  migrateMemoryReducerCheckpoints,
  migrateMessagesFtsBackfill,
  migrateNormalizePhoneIdentities,
  migrateNotificationDeliveryThreadDecision,
  migrateOAuthAppsClientSecretPath,
  migrateOAuthProvidersDisplayMetadata,
  migrateOAuthProvidersManagedServiceConfigKey,
  migrateOAuthProvidersPingUrl,
  migrateReminderRoutingIntent,
  migrateRemindersToSchedules,
  migrateRenameConversationTypeColumn,
  migrateRenameCreatedBySessionIdColumns,
  migrateRenameFollowupsThreadIdColumn,
  migrateRenameGmailProviderKeyToGoogle,
  migrateRenameGuardianVerificationValues,
  migrateRenameInboxThreadStateTable,
  migrateRenameNotificationThreadColumns,
  migrateRenameSequenceEnrollmentsThreadIdColumn,
  migrateRenameSequenceStepsReplyKey,
  migrateRenameSourceSessionIdColumn,
  migrateRenameThreadStartersCheckpoints,
  migrateRenameThreadStartersTable,
  migrateRenameVerificationSessionIdColumn,
  migrateRenameVerificationTable,
  migrateRenameVoiceToPhone,
  migrateScheduleOneShotRouting,
  migrateScheduleQuietFlag,
  migrateSchemaIndexesAndColumns,
  migrateUsageDashboardIndexes,
  migrateVoiceInviteColumns,
  migrateVoiceInviteDisplayMetadata,
  recoverCrashedMigrations,
  runComplexMigrations,
  runLateMigrations,
  validateMigrationState,
} from "./migrations/index.js";

// ---------------------------------------------------------------------------
// Test DB template — run migrations once, reuse across test files
// ---------------------------------------------------------------------------

function getTemplateDbPath(): string {
  // Hash this file + all migration files so the template auto-invalidates
  // when any migration changes.
  const thisFile = new URL(import.meta.url).pathname;
  const hash = createHash("md5");
  hash.update(readFileSync(thisFile, "utf-8"));
  const migrationsDir = join(dirname(thisFile), "migrations");
  for (const name of readdirSync(migrationsDir).sort()) {
    if (name.endsWith(".ts")) {
      hash.update(readFileSync(join(migrationsDir, name), "utf-8"));
    }
  }
  return join(
    tmpdir(),
    `vellum-test-db-template-${hash.digest("hex").slice(0, 12)}.db`,
  );
}

function tryRestoreTemplate(): boolean {
  const templatePath = getTemplateDbPath();
  if (!existsSync(templatePath)) return false;
  // getDb() hasn't run yet, so the data directory may not exist.
  ensureDataDir();
  copyFileSync(templatePath, getDbPath());
  // Open the pre-migrated copy — getDb() will set PRAGMAs but skip migrations.
  getDb();
  return true;
}

function saveTemplate(): void {
  try {
    // Flush WAL to main DB file before copying.
    getSqlite().exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const tmpFile = `${getTemplateDbPath()}.${process.pid}`;
    copyFileSync(getDbPath(), tmpFile);
    // Atomic rename — safe even with parallel test workers.
    renameSync(tmpFile, getTemplateDbPath());
  } catch {
    // Best effort — next file will just run migrations normally.
  }
}

// ---------------------------------------------------------------------------

export function initializeDb(): void {
  if (process.env.BUN_TEST === "1" && tryRestoreTemplate()) {
    return;
  }

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

  // 14c3. Guardian action supersession metadata (superseded_by_request_id, superseded_at) + session lookup index
  migrateGuardianActionSupersession(database);

  // 14d. Index on conversations.conversation_type for frequent WHERE filters
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

  // 23. Conversation decision audit columns on notification_deliveries
  migrateNotificationDeliveryThreadDecision(database);

  // 24. Canonical guardian requests and deliveries (unified cross-source guardian domain)
  createCanonicalGuardianTables(database);

  // 24b. Add requester_chat_id to canonical_guardian_requests (chat ID != user ID on some channels)
  migrateCanonicalGuardianRequesterChatId(database);

  // 24c. Composite index on canonical_guardian_deliveries(destination_channel, destination_chat_id) for chat-based lookups
  migrateCanonicalGuardianDeliveriesDestinationIndex(database);

  // 25. Normalize phone-like identity fields to E.164 across guardian and ingress tables
  migrateNormalizePhoneIdentities(database);

  // 26. Voice invite columns on assistant_ingress_invites
  migrateVoiceInviteColumns(database);

  // 27. Voice invite display metadata (friend_name, guardian_name) for personalized prompts
  migrateVoiceInviteDisplayMetadata(database);

  // 27b. 6-digit invite code hash column for non-voice channel invite redemption
  migrateInviteCodeHashColumn(database);

  // 28. Actor token records (hash-only actor token persistence)
  createActorTokenRecordsTable(database);

  // 28b. Actor refresh token records (rotating refresh tokens with family tracking)
  createActorRefreshTokenRecordsTable(database);

  // 29. Guardian principal ID columns on channel_guardian_bindings and canonical_guardian_requests
  migrateGuardianPrincipalIdColumns(database);

  // 30. Backfill guardianPrincipalId for existing bindings and requests, expire unresolvable pending requests
  migrateBackfillGuardianPrincipalId(database);

  // 31. Enforce NOT NULL on channel_guardian_bindings.guardian_principal_id
  migrateGuardianPrincipalIdNotNull(database);

  // 32. Add role and principal_id columns to contacts table
  migrateContactsRolePrincipal(database);

  // 33. Add verification and access-control columns to contact_channels
  migrateContactChannelsAccessFields(database);

  // 34. Composite index on (type, external_chat_id) for contact channel lookups
  migrateContactChannelsTypeChatIdIndex(database);

  // 35. Safety-sync remaining legacy data then drop assistant_ingress_members and channel_guardian_bindings
  migrateDropLegacyMemberGuardianTables(database);

  // 36. Add assistant_id to contacts for per-assistant guardian scoping
  migrateContactsAssistantId(database);

  // 37. Add contact_type to contacts and assistant_contact_metadata table
  migrateAssistantContactMetadata(database);

  // 38. Consolidate contact metadata columns into single notes field
  migrateContactsNotesColumn(database);

  // 39. Backfill contact interaction stats from channel lastSeenAt
  migrateBackfillContactInteractionStats(database);

  // 40. Drop assistant_id columns from all 16 daemon tables
  migrateDropAssistantIdColumns(database);

  // 41. Indexes on llm_usage_events for usage dashboard time-range and breakdown queries
  migrateUsageDashboardIndexes(database);

  // 42. (skipped) migrateReorderUsageDashboardIndexes — superseded by 43 which drops
  // all composite indexes that 42 would create, so running it is wasted work.

  // 43. Drop all composite usage indexes — they don't eliminate temp B-trees for GROUP BY
  migrateDropUsageCompositeIndexes(database);

  // 44. Backfill historical Anthropic usage rows from request-log truth before dashboard reads
  migrateBackfillUsageCacheAccounting(database);

  // 45. Rename channel_guardian_verification_challenges → channel_verification_sessions
  migrateRenameVerificationTable(database);

  // 46. Rename guardian_verification_session_id → verification_session_id in call_sessions
  migrateRenameVerificationSessionIdColumn(database);

  // 47. Rename persisted guardian_verification call_mode and event_type values
  migrateRenameGuardianVerificationValues(database);

  // 48. Rename stored "voice" channel values to "phone" across all channel text columns
  migrateRenameVoiceToPhone(database);

  // 49. Drop the unused legacy accounts table after removing account_manage
  migrateDropAccountsTable(database);

  // 50. Extend cron_jobs table with one-shot and routing support
  migrateScheduleOneShotRouting(database);

  // 51. Migrate existing reminders into cron_jobs as one-shot schedules
  migrateRemindersToSchedules(database);

  // 52. Drop the legacy reminders table after data migration
  migrateDropRemindersTable(database);

  // 53. OAuth provider/app/connection tables
  createOAuthTables(database);

  // 54. Add explicit client_secret_credential_path to oauth_apps
  migrateOAuthAppsClientSecretPath(database);

  // 55. Add ping_url column to oauth_providers
  migrateOAuthProvidersPingUrl(database);

  // 56. Add supersession tracking columns and override confidence to memory_items
  migrateMemoryItemSupersession(database);

  // 56b. Drop unused entity tables (entity search replaced by hybrid search on item statements)
  migrateDropEntityTables(database);

  // 57. Drop memory_segment_fts virtual table and triggers (replaced by Qdrant hybrid search)
  migrateDropMemorySegmentFts(database);

  // 58. Drop memory_item_conflicts table (conflict resolution system removed)
  migrateDropConflicts(database);

  // 59. Add invite metadata columns to call_sessions for outbound invite call routing
  migrateCallSessionInviteMetadata(database);

  // 60. Add required contact_id to assistant_ingress_invites and clean up legacy rows
  migrateInviteContactId(database);

  // 61. Add interaction_count and last_interaction columns to contact_channels
  migrateChannelInteractionColumns(database);

  // 62. Drop interaction_count and last_interaction columns from contacts (now derived from channels)
  migrateDropContactInteractionColumns(database);

  // 63. Drop loopback_port column from oauth_providers (moved to code-side behavior registry)
  migrateDropLoopbackPortColumn(database);

  // 64. Drop orphaned media tables (CREATE TABLE removed in #16739, clean up existing databases)
  migrateDropOrphanedMediaTables(database);

  // 65. Convert guardian timestamps from ISO 8601 text to epoch ms integers
  migrateGuardianTimestampsEpochMs(database);

  // 66. Rename assistant_inbox_thread_state → assistant_inbox_conversation_state
  migrateRenameInboxThreadStateTable(database);

  // 67. Rename thread_type → conversation_type in conversations table
  migrateRenameConversationTypeColumn(database);

  // 68. Rename notification_deliveries thread columns → conversation columns
  migrateRenameNotificationThreadColumns(database);

  // 69. Rename followups.thread_id → conversation_id
  migrateRenameFollowupsThreadIdColumn(database);

  // 70. Rename sequence_enrollments.thread_id → conversation_id
  migrateRenameSequenceEnrollmentsThreadIdColumn(database);

  // 71. Rename replyToThread → replyInSameConversation in sequence steps JSON blobs
  migrateRenameSequenceStepsReplyKey(database);

  // 72. Rename integration:gmail → integration:google across OAuth tables
  migrateRenameGmailProviderKeyToGoogle(database);

  // 73. Create thread_starters table for personalized empty-thread suggestions (renamed in migration 77)
  migrateCreateThreadStartersTable(database);

  // 74. Add capability card columns to thread_starters + category relevance table
  migrateCapabilityCardColumns(database);

  // 75. Rename created_by_session_id → source_conversation_id in verification sessions and invites
  migrateRenameCreatedBySessionIdColumns(database);

  // 76. Rename source_session_id → source_context_id in notification_events
  migrateRenameSourceSessionIdColumn(database);

  // 77. Rename thread_starters → conversation_starters table and indexes
  migrateRenameThreadStartersTable(database);

  // 77b. Rename checkpoint keys from thread_starters: → conversation_starters: prefix
  migrateRenameThreadStartersCheckpoints(database);

  // 78. Lifecycle events table for app_open / hatch telemetry
  createLifecycleEventsTable(database);

  // 79. Remove deleted capability-card state while keeping conversation starter chips
  migrateDropCapabilityCardState(database);

  // 80. Trace events table for persistent trace/activity storage across sessions
  migrateCreateTraceEventsTable(database);

  // 81. Add managed_service_config_key column to oauth_providers
  migrateOAuthProvidersManagedServiceConfigKey(database);

  // 81b. Add display metadata columns to oauth_providers (display_name, description, dashboard_url, etc.)
  migrateOAuthProvidersDisplayMetadata(database);

  // 82. Add message_id column to llm_request_logs for per-message LLM context lookup
  migrateLlmRequestLogMessageId(database);

  // 82b. Add provider column to llm_request_logs for runtime provider lookup
  migrateLlmRequestLogProvider(database);

  // 83. Backfill existing inline (base64-in-DB) attachments to on-disk storage
  migrateBackfillInlineAttachmentsToDisk(database);

  // 84. Add nullable conversation fork lineage columns and parent lookup index
  migrateConversationForkLineage(database);

  // 85. Memory brief state tables (time_contexts, open_loops) for simplified memory system
  migrateMemoryBriefState(database);

  // 86. Memory archive tables (observations, chunks, episodes) for simplified memory v1
  migrateMemoryArchiveTables(database);

  // 87. Add memory reducer checkpoint columns to conversations
  migrateMemoryReducerCheckpoints(database);

  // 88. Add quiet flag to schedule jobs
  migrateScheduleQuietFlag(database);

  validateMigrationState(database);

  if (process.env.BUN_TEST === "1") {
    saveTemplate();
  }
}

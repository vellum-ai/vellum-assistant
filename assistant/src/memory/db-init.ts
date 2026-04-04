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

import { getLogger } from "../util/logger.js";
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
  migrateAddSourceTypeColumns,
  migrateAssistantContactMetadata,
  migrateBackfillAudioAttachmentMimeTypes,
  migrateBackfillContactInteractionStats,
  migrateBackfillGuardianPrincipalId,
  migrateBackfillInlineAttachmentsToDisk,
  migrateBackfillUsageCacheAccounting,
  migrateCallSessionInviteMetadata,
  migrateCallSessionMode,
  migrateCallSessionSkipDisclosure,
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
  migrateContactsUserFileColumn,
  migrateConversationForkLineage,
  migrateConversationsLastMessageAt,
  migrateConversationsThreadTypeIndex,
  migrateCreateConversationGraphMemoryState,
  migrateCreateMemoryGraphNodeEdits,
  migrateCreateMemoryGraphTables,
  migrateCreateMemoryRecallLogs,
  migrateCreateThreadStartersTable,
  migrateCreateTraceEventsTable,
  migrateDropAccountsTable,
  migrateDropAssistantIdColumns,
  migrateDropCallbackTransportColumn,
  migrateDropCapabilityCardState,
  migrateDropConflicts,
  migrateDropContactInteractionColumns,
  migrateDropEntityTables,
  migrateDropLegacyMemberGuardianTables,
  migrateDropLoopbackPortColumn,
  migrateDropMemoryItemsTables,
  migrateDropMemorySegmentFts,
  migrateDropOrphanedMediaTables,
  migrateDropRemindersTable,
  migrateDropSetupSkillIdColumn,
  migrateDropSimplifiedMemory,
  migrateDropUsageCompositeIndexes,
  migrateFkCascadeRebuilds,
  migrateGuardianActionFollowup,
  migrateGuardianActionSupersession,
  migrateGuardianActionToolMetadata,
  migrateGuardianBootstrapToken,
  migrateGuardianDeliveryConversationIndex,
  migrateGuardianPrincipalIdColumns,
  migrateGuardianPrincipalIdNotNull,
  migrateGuardianRequestEnrichmentColumns,
  migrateGuardianTimestampsEpochMs,
  migrateGuardianVerificationPurpose,
  migrateGuardianVerificationSessions,
  migrateInviteCodeHashColumn,
  migrateInviteContactId,
  migrateLlmRequestLogMessageId,
  migrateLlmRequestLogProvider,
  migrateMemoryGraphImageRefs,
  migrateMemoryItemSupersession,
  migrateMemoryRecallLogsQueryContext,
  migrateMessagesConversationCreatedAtIndex,
  migrateMessagesFtsBackfill,
  migrateNormalizePhoneIdentities,
  migrateNotificationDeliveryThreadDecision,
  migrateOAuthAppsClientSecretPath,
  migrateOAuthProvidersBehaviorColumns,
  migrateOAuthProvidersDisplayMetadata,
  migrateOAuthProvidersFeatureFlag,
  migrateOAuthProvidersManagedServiceConfigKey,
  migrateOAuthProvidersPingConfig,
  migrateOAuthProvidersPingUrl,
  migrateReminderRoutingIntent,
  migrateRemindersToSchedules,
  migrateRenameConversationTypeColumn,
  migrateRenameCreatedBySessionIdColumns,
  migrateRenameFollowupsThreadIdColumn,
  migrateRenameGmailProviderKeyToGoogle,
  migrateRenameGuardianVerificationValues,
  migrateRenameInboxThreadStateTable,
  migrateRenameMemoryGraphTypeValues,
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
  migrateScheduleReuseConversation,
  migrateSchemaIndexesAndColumns,
  migrateScrubCorruptedImageAttachments,
  migrateStripIntegrationPrefixFromProviderKeys,
  migrateStripThinkingFromConsolidated,
  migrateUsageDashboardIndexes,
  migrateUsageLlmCallCount,
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
  // Hash this file + all migration files + bootstrap migration so the template
  // auto-invalidates when any migration changes.
  const thisFile = new URL(import.meta.url).pathname;
  const hash = createHash("md5");
  hash.update(readFileSync(thisFile, "utf-8"));
  const migrationsDir = join(dirname(thisFile), "migrations");
  for (const name of readdirSync(migrationsDir).sort()) {
    if (name.endsWith(".ts")) {
      hash.update(readFileSync(join(migrationsDir, name), "utf-8"));
    }
  }
  // Include bootstrap.ts which contains cleanup migrations (cleanupStaleItemVectors)
  // that run during initializeDb but live outside the migrations/ directory.
  const bootstrapFile = join(dirname(thisFile), "graph", "bootstrap.ts");
  if (existsSync(bootstrapFile)) {
    hash.update(readFileSync(bootstrapFile, "utf-8"));
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

  const log = getLogger("db-init");

  // Track migration failures so we can report a summary at the end.
  const failures: string[] = [];

  /**
   * Run a single migration step, catching and logging any error so it doesn't
   * propagate up and abort the entire initialization sequence. Later migrations
   * may still succeed even if an earlier one fails (e.g. an ALTER-TABLE
   * migration is independent of an index migration).
   */
  function safeMigrate(name: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      failures.push(name);
      log.error({ err, migration: name }, `Migration failed: ${name}`);
    }
  }

  const database = getDb();

  // 1. Create core tables (conversations, messages, memory, etc.)
  safeMigrate("createCoreTables", () => createCoreTables(database));

  // 1b. Clear any stalled 'started' checkpoints left by previous crashes
  // so the affected migrations can re-run from scratch.
  safeMigrate("recoverCrashedMigrations", () =>
    recoverCrashedMigrations(database),
  );

  // 2. Create watchers, logs, entities, FTS, and conversation keys
  safeMigrate("createWatchersAndLogsTables", () =>
    createWatchersAndLogsTables(database),
  );

  // 3. ALTER TABLE ADD COLUMN migrations for core tables
  safeMigrate("addCoreColumns", () => addCoreColumns(database));

  // 4. Complex multi-step migrations (dedup, FK fixes, assistant_id normalization)
  safeMigrate("runComplexMigrations", () => runComplexMigrations(database));

  // 5. Indexes for core tables + attachment dedup
  safeMigrate("createCoreIndexes", () => createCoreIndexes(database));

  // 6. Contacts and triage
  safeMigrate("createContactsAndTriageTables", () =>
    createContactsAndTriageTables(database),
  );

  // 7. Call sessions (outgoing AI phone calls)
  safeMigrate("createCallSessionsTables", () =>
    createCallSessionsTables(database),
  );

  // 7b. Call session mode/metadata for deterministic flow selection
  safeMigrate("migrateCallSessionMode", () => migrateCallSessionMode(database));

  // 8. Follow-ups
  safeMigrate("createFollowupsTables", () => createFollowupsTables(database));

  // 9. Tasks and work items
  safeMigrate("createTasksAndWorkItemsTables", () =>
    createTasksAndWorkItemsTables(database),
  );

  // 10. External conversation bindings
  safeMigrate("createExternalConversationBindingsTables", () =>
    createExternalConversationBindingsTables(database),
  );

  // 11. Channel guardian
  safeMigrate("createChannelGuardianTables", () =>
    createChannelGuardianTables(database),
  );

  // 11b. Guardian verification session columns (outbound identity binding)
  safeMigrate("migrateGuardianVerificationSessions", () =>
    migrateGuardianVerificationSessions(database),
  );

  // 11c. Guardian bootstrap token hash column (Telegram deep-link flow)
  safeMigrate("migrateGuardianBootstrapToken", () =>
    migrateGuardianBootstrapToken(database),
  );

  // 11d. Guardian verification purpose discriminator (guardian vs trusted_contact)
  safeMigrate("migrateGuardianVerificationPurpose", () =>
    migrateGuardianVerificationPurpose(database),
  );

  // 12. Media assets
  safeMigrate("createMediaAssetsTables", () =>
    createMediaAssetsTables(database),
  );

  // 13. Assistant inbox
  safeMigrate("createAssistantInboxTables", () =>
    createAssistantInboxTables(database),
  );

  // 14. Late-stage migrations (guardian actions, FTS backfill, index migrations)
  safeMigrate("runLateMigrations", () => runLateMigrations(database));

  // 14b. Track per-segment delivery progress for split channel replies
  safeMigrate("migrateChannelInboundDeliveredSegments", () =>
    migrateChannelInboundDeliveredSegments(database),
  );

  // 14c. Guardian action follow-up lifecycle columns (timeout reason, late answers)
  safeMigrate("migrateGuardianActionFollowup", () =>
    migrateGuardianActionFollowup(database),
  );

  // 14c2. Guardian action tool-approval metadata columns (tool_name, input_digest)
  safeMigrate("migrateGuardianActionToolMetadata", () =>
    migrateGuardianActionToolMetadata(database),
  );

  // 14c3. Guardian action supersession metadata (superseded_by_request_id, superseded_at) + session lookup index
  safeMigrate("migrateGuardianActionSupersession", () =>
    migrateGuardianActionSupersession(database),
  );

  // 14d. Index on conversations.conversation_type for frequent WHERE filters
  safeMigrate("migrateConversationsThreadTypeIndex", () =>
    migrateConversationsThreadTypeIndex(database),
  );

  // 14e. Index on guardian_action_deliveries.destination_conversation_id for conversation-based lookups
  safeMigrate("migrateGuardianDeliveryConversationIndex", () =>
    migrateGuardianDeliveryConversationIndex(database),
  );

  // 15. Notification system
  safeMigrate("createNotificationTables", () =>
    createNotificationTables(database),
  );

  // 16. Sequences (multi-step outreach)
  safeMigrate("createSequenceTables", () => createSequenceTables(database));

  // 17. Messages FTS (full-text search over message content)
  safeMigrate("createMessagesFts", () => createMessagesFts(database));
  safeMigrate("migrateMessagesFtsBackfill", () =>
    migrateMessagesFtsBackfill(database),
  );

  // 18. Conversation attention (seen-state tracking)
  safeMigrate("createConversationAttentionTables", () =>
    createConversationAttentionTables(database),
  );

  // 19. Reminder routing metadata (routing_intent + routing_hints_json columns)
  safeMigrate("migrateReminderRoutingIntent", () =>
    migrateReminderRoutingIntent(database),
  );

  // 20. Schema indexes, columns, and constraints
  safeMigrate("migrateSchemaIndexesAndColumns", () =>
    migrateSchemaIndexesAndColumns(database),
  );

  // 21. Rebuild tables to add ON DELETE CASCADE to FK constraints
  safeMigrate("migrateFkCascadeRebuilds", () =>
    migrateFkCascadeRebuilds(database),
  );

  // 22. Scoped approval grants (channel-agnostic one-time-use grants)
  safeMigrate("createScopedApprovalGrantsTable", () =>
    createScopedApprovalGrantsTable(database),
  );

  // 23. Conversation decision audit columns on notification_deliveries
  safeMigrate("migrateNotificationDeliveryThreadDecision", () =>
    migrateNotificationDeliveryThreadDecision(database),
  );

  // 24. Canonical guardian requests and deliveries (unified cross-source guardian domain)
  safeMigrate("createCanonicalGuardianTables", () =>
    createCanonicalGuardianTables(database),
  );

  // 24b. Add requester_chat_id to canonical_guardian_requests (chat ID != user ID on some channels)
  safeMigrate("migrateCanonicalGuardianRequesterChatId", () =>
    migrateCanonicalGuardianRequesterChatId(database),
  );

  // 24c. Composite index on canonical_guardian_deliveries(destination_channel, destination_chat_id) for chat-based lookups
  safeMigrate("migrateCanonicalGuardianDeliveriesDestinationIndex", () =>
    migrateCanonicalGuardianDeliveriesDestinationIndex(database),
  );

  // 25. Normalize phone-like identity fields to E.164 across guardian and ingress tables
  safeMigrate("migrateNormalizePhoneIdentities", () =>
    migrateNormalizePhoneIdentities(database),
  );

  // 26. Voice invite columns on assistant_ingress_invites
  safeMigrate("migrateVoiceInviteColumns", () =>
    migrateVoiceInviteColumns(database),
  );

  // 27. Voice invite display metadata (friend_name, guardian_name) for personalized prompts
  safeMigrate("migrateVoiceInviteDisplayMetadata", () =>
    migrateVoiceInviteDisplayMetadata(database),
  );

  // 27b. 6-digit invite code hash column for non-voice channel invite redemption
  safeMigrate("migrateInviteCodeHashColumn", () =>
    migrateInviteCodeHashColumn(database),
  );

  // 28. Actor token records (hash-only actor token persistence)
  safeMigrate("createActorTokenRecordsTable", () =>
    createActorTokenRecordsTable(database),
  );

  // 28b. Actor refresh token records (rotating refresh tokens with family tracking)
  safeMigrate("createActorRefreshTokenRecordsTable", () =>
    createActorRefreshTokenRecordsTable(database),
  );

  // 29. Guardian principal ID columns on channel_guardian_bindings and canonical_guardian_requests
  safeMigrate("migrateGuardianPrincipalIdColumns", () =>
    migrateGuardianPrincipalIdColumns(database),
  );

  // 30. Backfill guardianPrincipalId for existing bindings and requests, expire unresolvable pending requests
  safeMigrate("migrateBackfillGuardianPrincipalId", () =>
    migrateBackfillGuardianPrincipalId(database),
  );

  // 31. Enforce NOT NULL on channel_guardian_bindings.guardian_principal_id
  safeMigrate("migrateGuardianPrincipalIdNotNull", () =>
    migrateGuardianPrincipalIdNotNull(database),
  );

  // 32. Add role and principal_id columns to contacts table
  safeMigrate("migrateContactsRolePrincipal", () =>
    migrateContactsRolePrincipal(database),
  );

  // 33. Add verification and access-control columns to contact_channels
  safeMigrate("migrateContactChannelsAccessFields", () =>
    migrateContactChannelsAccessFields(database),
  );

  // 34. Composite index on (type, external_chat_id) for contact channel lookups
  safeMigrate("migrateContactChannelsTypeChatIdIndex", () =>
    migrateContactChannelsTypeChatIdIndex(database),
  );

  // 35. Safety-sync remaining legacy data then drop assistant_ingress_members and channel_guardian_bindings
  safeMigrate("migrateDropLegacyMemberGuardianTables", () =>
    migrateDropLegacyMemberGuardianTables(database),
  );

  // 36. Add assistant_id to contacts for per-assistant guardian scoping
  safeMigrate("migrateContactsAssistantId", () =>
    migrateContactsAssistantId(database),
  );

  // 37. Add contact_type to contacts and assistant_contact_metadata table
  safeMigrate("migrateAssistantContactMetadata", () =>
    migrateAssistantContactMetadata(database),
  );

  // 38. Consolidate contact metadata columns into single notes field
  safeMigrate("migrateContactsNotesColumn", () =>
    migrateContactsNotesColumn(database),
  );

  // 39. Backfill contact interaction stats from channel lastSeenAt
  safeMigrate("migrateBackfillContactInteractionStats", () =>
    migrateBackfillContactInteractionStats(database),
  );

  // 40. Drop assistant_id columns from all 16 daemon tables
  safeMigrate("migrateDropAssistantIdColumns", () =>
    migrateDropAssistantIdColumns(database),
  );

  // 41. Indexes on llm_usage_events for usage dashboard time-range and breakdown queries
  safeMigrate("migrateUsageDashboardIndexes", () =>
    migrateUsageDashboardIndexes(database),
  );

  // 42. (skipped) migrateReorderUsageDashboardIndexes — superseded by 43 which drops
  // all composite indexes that 42 would create, so running it is wasted work.

  // 43. Drop all composite usage indexes — they don't eliminate temp B-trees for GROUP BY
  safeMigrate("migrateDropUsageCompositeIndexes", () =>
    migrateDropUsageCompositeIndexes(database),
  );

  // 44. Backfill historical Anthropic usage rows from request-log truth before dashboard reads
  safeMigrate("migrateBackfillUsageCacheAccounting", () =>
    migrateBackfillUsageCacheAccounting(database),
  );

  // 45. Rename channel_guardian_verification_challenges → channel_verification_sessions
  safeMigrate("migrateRenameVerificationTable", () =>
    migrateRenameVerificationTable(database),
  );

  // 46. Rename guardian_verification_session_id → verification_session_id in call_sessions
  safeMigrate("migrateRenameVerificationSessionIdColumn", () =>
    migrateRenameVerificationSessionIdColumn(database),
  );

  // 47. Rename persisted guardian_verification call_mode and event_type values
  safeMigrate("migrateRenameGuardianVerificationValues", () =>
    migrateRenameGuardianVerificationValues(database),
  );

  // 48. Rename stored "voice" channel values to "phone" across all channel text columns
  safeMigrate("migrateRenameVoiceToPhone", () =>
    migrateRenameVoiceToPhone(database),
  );

  // 49. Drop the unused legacy accounts table after removing account_manage
  safeMigrate("migrateDropAccountsTable", () =>
    migrateDropAccountsTable(database),
  );

  // 50. Extend cron_jobs table with one-shot and routing support
  safeMigrate("migrateScheduleOneShotRouting", () =>
    migrateScheduleOneShotRouting(database),
  );

  // 51. Migrate existing reminders into cron_jobs as one-shot schedules
  safeMigrate("migrateRemindersToSchedules", () =>
    migrateRemindersToSchedules(database),
  );

  // 52. Drop the legacy reminders table after data migration
  safeMigrate("migrateDropRemindersTable", () =>
    migrateDropRemindersTable(database),
  );

  // 53. OAuth provider/app/connection tables
  safeMigrate("createOAuthTables", () => createOAuthTables(database));

  // 54. Add explicit client_secret_credential_path to oauth_apps
  safeMigrate("migrateOAuthAppsClientSecretPath", () =>
    migrateOAuthAppsClientSecretPath(database),
  );

  // 55. Add ping_url column to oauth_providers
  safeMigrate("migrateOAuthProvidersPingUrl", () =>
    migrateOAuthProvidersPingUrl(database),
  );

  // 56. Add supersession tracking columns and override confidence to memory_items
  safeMigrate("migrateMemoryItemSupersession", () =>
    migrateMemoryItemSupersession(database),
  );

  // 56b. Drop unused entity tables (entity search replaced by hybrid search on item statements)
  safeMigrate("migrateDropEntityTables", () =>
    migrateDropEntityTables(database),
  );

  // 57. Drop memory_segment_fts virtual table and triggers (replaced by Qdrant hybrid search)
  safeMigrate("migrateDropMemorySegmentFts", () =>
    migrateDropMemorySegmentFts(database),
  );

  // 58. Drop memory_item_conflicts table (conflict resolution system removed)
  safeMigrate("migrateDropConflicts", () => migrateDropConflicts(database));

  // 59. Add invite metadata columns to call_sessions for outbound invite call routing
  safeMigrate("migrateCallSessionInviteMetadata", () =>
    migrateCallSessionInviteMetadata(database),
  );

  // 60. Add required contact_id to assistant_ingress_invites and clean up legacy rows
  safeMigrate("migrateInviteContactId", () => migrateInviteContactId(database));

  // 61. Add interaction_count and last_interaction columns to contact_channels
  safeMigrate("migrateChannelInteractionColumns", () =>
    migrateChannelInteractionColumns(database),
  );

  // 62. Drop interaction_count and last_interaction columns from contacts (now derived from channels)
  safeMigrate("migrateDropContactInteractionColumns", () =>
    migrateDropContactInteractionColumns(database),
  );

  // 63. Drop loopback_port column from oauth_providers (moved to code-side behavior registry)
  safeMigrate("migrateDropLoopbackPortColumn", () =>
    migrateDropLoopbackPortColumn(database),
  );

  // 64. Drop orphaned media tables (CREATE TABLE removed in #16739, clean up existing databases)
  safeMigrate("migrateDropOrphanedMediaTables", () =>
    migrateDropOrphanedMediaTables(database),
  );

  // 65. Convert guardian timestamps from ISO 8601 text to epoch ms integers
  safeMigrate("migrateGuardianTimestampsEpochMs", () =>
    migrateGuardianTimestampsEpochMs(database),
  );

  // 66. Rename assistant_inbox_thread_state → assistant_inbox_conversation_state
  safeMigrate("migrateRenameInboxThreadStateTable", () =>
    migrateRenameInboxThreadStateTable(database),
  );

  // 67. Rename thread_type → conversation_type in conversations table
  safeMigrate("migrateRenameConversationTypeColumn", () =>
    migrateRenameConversationTypeColumn(database),
  );

  // 68. Rename notification_deliveries thread columns → conversation columns
  safeMigrate("migrateRenameNotificationThreadColumns", () =>
    migrateRenameNotificationThreadColumns(database),
  );

  // 69. Rename followups.thread_id → conversation_id
  safeMigrate("migrateRenameFollowupsThreadIdColumn", () =>
    migrateRenameFollowupsThreadIdColumn(database),
  );

  // 70. Rename sequence_enrollments.thread_id → conversation_id
  safeMigrate("migrateRenameSequenceEnrollmentsThreadIdColumn", () =>
    migrateRenameSequenceEnrollmentsThreadIdColumn(database),
  );

  // 71. Rename replyToThread → replyInSameConversation in sequence steps JSON blobs
  safeMigrate("migrateRenameSequenceStepsReplyKey", () =>
    migrateRenameSequenceStepsReplyKey(database),
  );

  // 72. Rename integration:gmail → integration:google across OAuth tables
  safeMigrate("migrateRenameGmailProviderKeyToGoogle", () =>
    migrateRenameGmailProviderKeyToGoogle(database),
  );

  // 73. Create thread_starters table for personalized empty-thread suggestions (renamed in migration 77)
  safeMigrate("migrateCreateThreadStartersTable", () =>
    migrateCreateThreadStartersTable(database),
  );

  // 74. Add capability card columns to thread_starters + category relevance table
  safeMigrate("migrateCapabilityCardColumns", () =>
    migrateCapabilityCardColumns(database),
  );

  // 75. Rename created_by_session_id → source_conversation_id in verification sessions and invites
  safeMigrate("migrateRenameCreatedBySessionIdColumns", () =>
    migrateRenameCreatedBySessionIdColumns(database),
  );

  // 76. Rename source_session_id → source_context_id in notification_events
  safeMigrate("migrateRenameSourceSessionIdColumn", () =>
    migrateRenameSourceSessionIdColumn(database),
  );

  // 77. Rename thread_starters → conversation_starters table and indexes
  safeMigrate("migrateRenameThreadStartersTable", () =>
    migrateRenameThreadStartersTable(database),
  );

  // 77b. Rename checkpoint keys from thread_starters: → conversation_starters: prefix
  safeMigrate("migrateRenameThreadStartersCheckpoints", () =>
    migrateRenameThreadStartersCheckpoints(database),
  );

  // 78. Lifecycle events table for app_open / hatch telemetry
  safeMigrate("createLifecycleEventsTable", () =>
    createLifecycleEventsTable(database),
  );

  // 79. Remove deleted capability-card state while keeping conversation starter chips
  safeMigrate("migrateDropCapabilityCardState", () =>
    migrateDropCapabilityCardState(database),
  );

  // 80. Trace events table for persistent trace/activity storage across sessions
  safeMigrate("migrateCreateTraceEventsTable", () =>
    migrateCreateTraceEventsTable(database),
  );

  // 81. Add managed_service_config_key column to oauth_providers
  safeMigrate("migrateOAuthProvidersManagedServiceConfigKey", () =>
    migrateOAuthProvidersManagedServiceConfigKey(database),
  );

  // 81b. Add display metadata columns to oauth_providers (display_name, description, dashboard_url, etc.)
  safeMigrate("migrateOAuthProvidersDisplayMetadata", () =>
    migrateOAuthProvidersDisplayMetadata(database),
  );

  // 82. Add message_id column to llm_request_logs for per-message LLM context lookup
  safeMigrate("migrateLlmRequestLogMessageId", () =>
    migrateLlmRequestLogMessageId(database),
  );

  // 82b. Add provider column to llm_request_logs for runtime provider lookup
  safeMigrate("migrateLlmRequestLogProvider", () =>
    migrateLlmRequestLogProvider(database),
  );

  // 83. Backfill existing inline (base64-in-DB) attachments to on-disk storage
  safeMigrate("migrateBackfillInlineAttachmentsToDisk", () =>
    migrateBackfillInlineAttachmentsToDisk(database),
  );

  // 84. Add nullable conversation fork lineage columns and parent lookup index
  safeMigrate("migrateConversationForkLineage", () =>
    migrateConversationForkLineage(database),
  );

  // 85. Add quiet flag to schedule jobs
  safeMigrate("migrateScheduleQuietFlag", () =>
    migrateScheduleQuietFlag(database),
  );

  // 86. Drop simplified-memory tables and reducer checkpoint columns
  safeMigrate("migrateDropSimplifiedMemory", () =>
    migrateDropSimplifiedMemory(database),
  );

  // 87. Add skip_disclosure column to call_sessions for per-call disclosure control
  safeMigrate("migrateCallSessionSkipDisclosure", () =>
    migrateCallSessionSkipDisclosure(database),
  );

  // 88. Backfill correct MIME types for audio attachments stored as application/octet-stream
  safeMigrate("migrateBackfillAudioAttachmentMimeTypes", () =>
    migrateBackfillAudioAttachmentMimeTypes(database),
  );

  // 89. Add user_file column to contacts for per-user persona file mapping
  safeMigrate("migrateContactsUserFileColumn", () =>
    migrateContactsUserFileColumn(database),
  );

  // 90. Add source_type and source_message_role columns to memory_items
  safeMigrate("migrateAddSourceTypeColumns", () =>
    migrateAddSourceTypeColumns(database),
  );

  // 91. Memory recall logs table for inspector memory tab
  safeMigrate("migrateCreateMemoryRecallLogs", () =>
    migrateCreateMemoryRecallLogs(database),
  );

  // 92. Add ping_method, ping_headers, ping_body columns to oauth_providers
  safeMigrate("migrateOAuthProvidersPingConfig", () =>
    migrateOAuthProvidersPingConfig(database),
  );

  // 93. Strip `integration:` prefix from provider_key across OAuth tables
  safeMigrate("migrateStripIntegrationPrefixFromProviderKeys", () =>
    migrateStripIntegrationPrefixFromProviderKeys(database),
  );

  // 94. Composite index on messages(conversation_id, created_at) for paginated history queries
  safeMigrate("migrateMessagesConversationCreatedAtIndex", () =>
    migrateMessagesConversationCreatedAtIndex(database),
  );

  // 95. Add behavioral config columns to oauth_providers (loopback port, injection templates, setup metadata, identity verification)
  safeMigrate("migrateOAuthProvidersBehaviorColumns", () =>
    migrateOAuthProvidersBehaviorColumns(database),
  );

  // 96. Drop the setup_skill_id column from oauth_providers (concept removed)
  safeMigrate("migrateDropSetupSkillIdColumn", () =>
    migrateDropSetupSkillIdColumn(database),
  );

  // 97. Add enrichment columns to canonical_guardian_requests for guardian approval UX
  safeMigrate("migrateGuardianRequestEnrichmentColumns", () =>
    migrateGuardianRequestEnrichmentColumns(database),
  );

  // 98. Add llm_call_count column to llm_usage_events for accurate LLM call counting
  safeMigrate("migrateUsageLlmCallCount", () =>
    migrateUsageLlmCallCount(database),
  );

  // 99. Add feature_flag column to oauth_providers for feature-flag gating
  safeMigrate("migrateOAuthProvidersFeatureFlag", () =>
    migrateOAuthProvidersFeatureFlag(database),
  );

  // 100. Drop the vestigial callback_transport column from oauth_providers
  // (transport is now chosen per-flow via the callbackTransport option, not per-provider)
  safeMigrate("migrateDropCallbackTransportColumn", () =>
    migrateDropCallbackTransportColumn(database),
  );

  // 101. Memory graph tables (nodes, edges, triggers)
  safeMigrate("migrateCreateMemoryGraphTables", () =>
    migrateCreateMemoryGraphTables(database),
  );

  // 101a. Add nullable image_refs TEXT column to memory_graph_nodes
  safeMigrate("migrateMemoryGraphImageRefs", () =>
    migrateMemoryGraphImageRefs(database),
  );

  // 102. Drop legacy memory_items and memory_item_sources tables (migrated to memory_graph_nodes)
  safeMigrate("migrateDropMemoryItemsTables", () =>
    migrateDropMemoryItemsTables(database),
  );

  // 103. Rename legacy memory graph node type values: style → behavioral, relationship → semantic
  safeMigrate("migrateRenameMemoryGraphTypeValues", () =>
    migrateRenameMemoryGraphTypeValues(database),
  );

  // 104. Memory graph node edit history
  safeMigrate("migrateCreateMemoryGraphNodeEdits", () =>
    migrateCreateMemoryGraphNodeEdits(database),
  );

  // 105. Remove image attachments containing HTML error pages instead of image data
  safeMigrate("migrateScrubCorruptedImageAttachments", () =>
    migrateScrubCorruptedImageAttachments(database),
  );

  // 106. Persist graph memory tracker state across conversation eviction
  safeMigrate("migrateCreateConversationGraphMemoryState", () =>
    migrateCreateConversationGraphMemoryState(database),
  );

  // 107. Add last_message_at denormalized column for message-based sorting
  safeMigrate("migrateConversationsLastMessageAt", () =>
    migrateConversationsLastMessageAt(database),
  );

  // 108. Strip thinking/redacted_thinking from consolidated assistant messages
  // so the Anthropic provider no longer needs to mutate historical messages,
  // enabling append-only conversation history for prefix caching.
  safeMigrate("migrateStripThinkingFromConsolidated", () =>
    migrateStripThinkingFromConsolidated(database),
  );

  // 109. Add reuse_conversation flag to schedule jobs
  safeMigrate("migrateScheduleReuseConversation", () =>
    migrateScheduleReuseConversation(database),
  );

  // 110. Add query_context column to memory_recall_logs for inspector query display
  safeMigrate("migrateMemoryRecallLogsQueryContext", () =>
    migrateMemoryRecallLogsQueryContext(database),
  );

  safeMigrate("validateMigrationState", () => validateMigrationState(database));

  if (failures.length > 0) {
    const msg = `DB initialization completed with ${failures.length} failed migration(s)`;
    log.error({ failedMigrations: failures, count: failures.length }, msg);
    // Re-throw so lifecycle.ts can detect the failure and enter degraded mode.
    // Individual errors have already been logged above, so the caller gets a
    // summary while the log still contains per-migration detail.
    throw new Error(`${msg}: ${failures.join(", ")}`);
  }

  if (process.env.BUN_TEST === "1") {
    saveTemplate();
  }
}

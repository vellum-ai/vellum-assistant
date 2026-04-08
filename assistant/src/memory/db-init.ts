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
import { migrateToolCreatedItems } from "./graph/bootstrap.js";
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
  migrateLlmRequestLogsCreatedAtIndex,
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
  migrateOAuthProvidersRefreshUrl,
  migrateOAuthProvidersRevoke,
  migrateOAuthProvidersScopeSeparator,
  migrateOAuthProvidersTokenAuthMethodDefault,
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
  // Include the bootstrap migration (migrateToolCreatedItems) which also runs
  // during initializeDb but lives outside the migrations/ directory.
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
  const database = getDb();

  // Every migration step, in execution order. Each function accepts a
  // DrizzleDb and is identified by its .name.
  const migrationSteps = [
    createCoreTables,
    recoverCrashedMigrations,
    createWatchersAndLogsTables,
    addCoreColumns,
    runComplexMigrations,
    createCoreIndexes,
    createContactsAndTriageTables,
    createCallSessionsTables,
    migrateCallSessionMode,
    createFollowupsTables,
    createTasksAndWorkItemsTables,
    createExternalConversationBindingsTables,
    createChannelGuardianTables,
    migrateGuardianVerificationSessions,
    migrateGuardianBootstrapToken,
    migrateGuardianVerificationPurpose,
    createMediaAssetsTables,
    createAssistantInboxTables,
    runLateMigrations,
    migrateChannelInboundDeliveredSegments,
    migrateGuardianActionFollowup,
    migrateGuardianActionToolMetadata,
    migrateGuardianActionSupersession,
    migrateConversationsThreadTypeIndex,
    migrateGuardianDeliveryConversationIndex,
    createNotificationTables,
    createSequenceTables,
    createMessagesFts,
    migrateMessagesFtsBackfill,
    createConversationAttentionTables,
    migrateReminderRoutingIntent,
    migrateSchemaIndexesAndColumns,
    migrateFkCascadeRebuilds,
    createScopedApprovalGrantsTable,
    migrateNotificationDeliveryThreadDecision,
    createCanonicalGuardianTables,
    migrateCanonicalGuardianRequesterChatId,
    migrateCanonicalGuardianDeliveriesDestinationIndex,
    migrateNormalizePhoneIdentities,
    migrateVoiceInviteColumns,
    migrateVoiceInviteDisplayMetadata,
    migrateInviteCodeHashColumn,
    createActorTokenRecordsTable,
    createActorRefreshTokenRecordsTable,
    migrateGuardianPrincipalIdColumns,
    migrateBackfillGuardianPrincipalId,
    migrateGuardianPrincipalIdNotNull,
    migrateContactsRolePrincipal,
    migrateContactChannelsAccessFields,
    migrateContactChannelsTypeChatIdIndex,
    migrateDropLegacyMemberGuardianTables,
    migrateContactsAssistantId,
    migrateAssistantContactMetadata,
    migrateContactsNotesColumn,
    migrateBackfillContactInteractionStats,
    migrateDropAssistantIdColumns,
    migrateUsageDashboardIndexes,
    // 42. (skipped) migrateReorderUsageDashboardIndexes — superseded by 43
    migrateDropUsageCompositeIndexes,
    migrateBackfillUsageCacheAccounting,
    migrateRenameVerificationTable,
    migrateRenameVerificationSessionIdColumn,
    migrateRenameGuardianVerificationValues,
    migrateRenameVoiceToPhone,
    migrateDropAccountsTable,
    migrateScheduleOneShotRouting,
    migrateRemindersToSchedules,
    migrateDropRemindersTable,
    createOAuthTables,
    migrateOAuthAppsClientSecretPath,
    migrateOAuthProvidersPingUrl,
    migrateMemoryItemSupersession,
    migrateDropEntityTables,
    migrateDropMemorySegmentFts,
    migrateDropConflicts,
    migrateCallSessionInviteMetadata,
    migrateInviteContactId,
    migrateChannelInteractionColumns,
    migrateDropContactInteractionColumns,
    migrateDropLoopbackPortColumn,
    migrateDropOrphanedMediaTables,
    migrateGuardianTimestampsEpochMs,
    migrateRenameInboxThreadStateTable,
    migrateRenameConversationTypeColumn,
    migrateRenameNotificationThreadColumns,
    migrateRenameFollowupsThreadIdColumn,
    migrateRenameSequenceEnrollmentsThreadIdColumn,
    migrateRenameSequenceStepsReplyKey,
    migrateRenameGmailProviderKeyToGoogle,
    migrateCreateThreadStartersTable,
    migrateCapabilityCardColumns,
    migrateRenameCreatedBySessionIdColumns,
    migrateRenameSourceSessionIdColumn,
    migrateRenameThreadStartersTable,
    migrateRenameThreadStartersCheckpoints,
    createLifecycleEventsTable,
    migrateDropCapabilityCardState,
    migrateCreateTraceEventsTable,
    migrateOAuthProvidersManagedServiceConfigKey,
    migrateOAuthProvidersDisplayMetadata,
    migrateLlmRequestLogMessageId,
    migrateLlmRequestLogProvider,
    migrateBackfillInlineAttachmentsToDisk,
    migrateConversationForkLineage,
    migrateScheduleQuietFlag,
    migrateDropSimplifiedMemory,
    migrateCallSessionSkipDisclosure,
    migrateBackfillAudioAttachmentMimeTypes,
    migrateContactsUserFileColumn,
    migrateAddSourceTypeColumns,
    migrateCreateMemoryRecallLogs,
    migrateOAuthProvidersPingConfig,
    migrateStripIntegrationPrefixFromProviderKeys,
    migrateMessagesConversationCreatedAtIndex,
    migrateOAuthProvidersBehaviorColumns,
    migrateDropSetupSkillIdColumn,
    migrateGuardianRequestEnrichmentColumns,
    migrateUsageLlmCallCount,
    migrateOAuthProvidersFeatureFlag,
    migrateDropCallbackTransportColumn,
    migrateCreateMemoryGraphTables,
    // 101a. Add nullable image_refs column — must run before migrateToolCreatedItems
    // which inserts rows into memory_graph_nodes including the image_refs column.
    migrateMemoryGraphImageRefs,
    // 101b. Migrate tool-created items from legacy memory_items → graph nodes.
    // Must run before migrateDropMemoryItemsTables so data is preserved.
    function migrateToolCreatedItemsStep() {
      migrateToolCreatedItems();
    },
    migrateDropMemoryItemsTables,
    migrateRenameMemoryGraphTypeValues,
    migrateCreateMemoryGraphNodeEdits,
    migrateScrubCorruptedImageAttachments,
    migrateCreateConversationGraphMemoryState,
    migrateConversationsLastMessageAt,
    migrateStripThinkingFromConsolidated,
    migrateScheduleReuseConversation,
    migrateMemoryRecallLogsQueryContext,
    migrateLlmRequestLogsCreatedAtIndex,
    migrateOAuthProvidersScopeSeparator,
    migrateOAuthProvidersRefreshUrl,
    migrateOAuthProvidersRevoke,
    migrateOAuthProvidersTokenAuthMethodDefault,
  ];

  // Run each migration step, catching and logging individual failures so one
  // broken migration doesn't prevent independent later ones from succeeding.
  const failures: string[] = [];
  for (const step of migrationSteps) {
    try {
      log.debug({ migration: step.name }, `Starting migration: ${step.name}`);
      step(database);
      log.debug({ migration: step.name }, `Migration succeeded: ${step.name}`);
    } catch (err) {
      failures.push(step.name);
      log.error(
        { err, migration: step.name },
        `Migration failed: ${step.name}`,
      );
    }
  }

  if (failures.length > 0) {
    log.error(
      { failedMigrations: failures, count: failures.length },
      `DB initialization completed with ${failures.length} failed migration(s)`,
    );
  }

  try {
    validateMigrationState(database);
  } catch (err) {
    log.error({ err }, "validateMigrationState failed");
  }

  if (process.env.BUN_TEST === "1") {
    saveTemplate();
  }
}

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
import { getLogsDbPath } from "../util/logs-db-path.js";
import { ensureDataDir, getDbPath } from "../util/platform.js";
import { backfillAppConversationIds } from "./app-store.js";
import { getDb, getSqlite } from "./db-connection.js";
import { migrateToolCreatedItems } from "./graph/bootstrap.js";
import {
  addCoreColumns,
  complexMigrationSteps,
  createActivationSessionsTable,
  createApprovalPromptTsTrackerTable,
  createAssistantInboxTables,
  createAuthFallbackEventsTable,
  createCallSessionsTables,
  createCanonicalGuardianTables,
  createChannelGuardianTables,
  createContactsAndTriageTables,
  createConversationAttentionTables,
  createCoreIndexes,
  createExternalConversationBindingsTables,
  createFollowupsTables,
  createLifecycleEventsTable,
  createMediaAssetsTables,
  createMessagesFts,
  createNotificationTables,
  createOAuthTables,
  createOnboardingEventsTable,
  createScopedApprovalGrantsTable,
  createSequenceTables,
  createSkillLoadedEventsTable,
  createTasksAndWorkItemsTables,
  createWatchersAndLogsTables,
  dropApprovalPromptTsTrackerTable,
  lateMigrationSteps,
  migrate230AcpSessionHistory,
  migrate231RepairMemoryGraphEventDates,
  migrateA2ATasks,
  migrateAcpSessionHistoryCwd,
  migrateActivationState,
  migrateActivationStateFkCascade,
  migrateAddConversationInferenceProfile,
  migrateAddMemoryV3EverInjected,
  migrateAddMemoryV3Selections,
  migrateAddSourceTypeColumns,
  migrateAssistantContactMetadata,
  migrateBackfillAudioAttachmentMimeTypes,
  migrateBackfillContactInteractionStats,
  migrateBackfillGuardianPrincipalId,
  migrateBackfillInlineAttachmentsToDisk,
  migrateBackfillOriginChannelFromBindings,
  migrateBackfillProviderConnectionLabel,
  migrateBackfillUsageCacheAccounting,
  migrateCallSessionInviteMetadata,
  migrateCallSessionMode,
  migrateCallSessionSkipDisclosure,
  migrateCanonicalGuardianDeliveriesDestinationIndex,
  migrateCanonicalGuardianRequesterChatId,
  migrateCapabilityCardColumns,
  migrateChannelInboundDeliveredSegments,
  migrateChannelInboundDeliveryAttempts,
  migrateChannelInteractionColumns,
  migrateContactChannelsAccessFields,
  migrateContactChannelsRenormalizeAddresses,
  migrateContactChannelsTypeChatIdIndex,
  migrateContactChannelsUniqueExtUser,
  migrateContactsAssistantId,
  migrateContactsNotesColumn,
  migrateContactsRolePrincipal,
  migrateContactsUserFileColumn,
  migrateConversationCleanedAt,
  migrateConversationForkLineage,
  migrateConversationHostAccess,
  migrateConversationInferenceProfileSession,
  migrateConversationLastNotifiedProfile,
  migrateConversationOriginChannelIndex,
  migrateConversationsArchivedAt,
  migrateConversationsLastMessageAt,
  migrateConversationsSurfacedAt,
  migrateConversationsThreadTypeIndex,
  migrateCoreTables,
  migrateCreateConversationGraphMemoryState,
  migrateCreateDocumentComments,
  migrateCreateDocumentConversations,
  migrateCreateMemoryGraphNodeEdits,
  migrateCreateMemoryGraphTables,
  migrateCreateMemoryRecallLogs,
  migrateCreateProviderConnections,
  migrateCreateThreadStartersTable,
  migrateCreateTraceEventsTable,
  migrateDeletePrivateConversations,
  migrateDropAccountsTable,
  migrateDropAssistantIdColumns,
  migrateDropCallbackTransportColumn,
  migrateDropCapabilityCardState,
  migrateDropConflicts,
  migrateDropContactInteractionColumns,
  migrateDropEntityTables,
  migrateDropExternalUserId,
  migrateDropLegacyMemberGuardianTables,
  migrateDropLoopbackPortColumn,
  migrateDropMemoryItemsTables,
  migrateDropMemorySegmentFts,
  migrateDropOrphanedMediaTables,
  migrateDropProviderConnectionStatus,
  migrateDropRemindersTable,
  migrateDropSetupSkillIdColumn,
  migrateDropSimplifiedMemory,
  migrateDropUsageCompositeIndexes,
  migrateExternalConversationBindingChatName,
  migrateExternalConversationBindingThreadId,
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
  migrateHeartbeatRuns,
  migrateInviteCodeHashColumn,
  migrateInviteContactId,
  migrateLlmRequestLogAgentLoopExitReason,
  migrateLlmRequestLogCallSite,
  migrateLlmRequestLogMessageId,
  migrateLlmRequestLogProvider,
  migrateLlmRequestLogsCreatedAtIndex,
  migrateLlmUsageAddRawUsage,
  migrateLlmUsageAttribution,
  migrateLlmUsageEventsAddAssistantVersion,
  migrateMemoryGraphImageRefs,
  migrateMemoryItemSupersession,
  migrateMemoryRecallLogsQueryContext,
  migrateMemoryRetrospectiveRememberedLog,
  migrateMemoryRetrospectiveState,
  migrateMemoryV2ActivationLogs,
  migrateMemoryV2InjectionEvents,
  migrateMemoryV3AutoEdges,
  migrateMemoryV3Coactivation,
  migrateMemoryV3SelectionsMessageIdAndSections,
  migrateMessageBookmarks,
  migrateMessagesClientMessageId,
  migrateMessagesConversationCreatedAtIndex,
  migrateMessagesFtsBackfill,
  migrateMessagesRoleCreatedAtIndex,
  migrateMoveLlmRequestLogsToLogsDb,
  migrateNormalizePhoneIdentities,
  migrateNormalizeSlackExternalContent,
  migrateNormalizeUserFileByPrincipal,
  migrateNotificationDeliveryThreadDecision,
  migrateOAuthAppsClientSecretPath,
  migrateOAuthProvidersAvailableScopes,
  migrateOAuthProvidersBehaviorColumns,
  migrateOAuthProvidersDisplayMetadata,
  migrateOAuthProvidersFeatureFlag,
  migrateOAuthProvidersLogoUrl,
  migrateOAuthProvidersManagedServiceConfigKey,
  migrateOAuthProvidersManagedServiceIsPaid,
  migrateOAuthProvidersPingConfig,
  migrateOAuthProvidersPingUrl,
  migrateOAuthProvidersRefreshUrl,
  migrateOAuthProvidersRevoke,
  migrateOAuthProvidersScopeSeparator,
  migrateOAuthProvidersTokenAuthMethodDefault,
  migrateOAuthProvidersTokenExchangeBodyFormat,
  migrateOnboardingEventsFunnelColumns,
  migrateOnboardingEventsPriorAssistants,
  migrateProviderConnectionBaseUrlAndModels,
  migrateProviderConnectionStatusLabel,
  migrateReminderRoutingIntent,
  migrateRemindersToSchedules,
  migrateRenameCleanedAt,
  migrateRenameConversationTypeColumn,
  migrateRenameCreatedBySessionIdColumns,
  migrateRenameFollowupsThreadIdColumn,
  migrateRenameGmailProviderKeyToGoogle,
  migrateRenameGuardianVerificationValues,
  migrateRenameInboxThreadStateTable,
  migrateRenameInferenceProfileSnakeCase,
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
  migrateRewriteBalancedEconomyProfilePins,
  migrateScheduleCapabilities,
  migrateScheduleDefaultNoReuseConversation,
  migrateScheduleDescription,
  migrateScheduleInferenceProfile,
  migrateScheduleOneShotRouting,
  migrateScheduleQuietFlag,
  migrateScheduleRetryPolicy,
  migrateScheduleReuseConversation,
  migrateScheduleScriptColumn,
  migrateScheduleScriptTimeout,
  migrateScheduleSourceConversation,
  migrateScheduleWakeConversationId,
  migrateScheduleWorkflowMode,
  migrateSchemaIndexesAndColumns,
  migrateScrubCorruptedImageAttachments,
  migrateSlackCompactionWatermark,
  migrateStripBaseUrlNonOpenaiCompatible,
  migrateStripIntegrationPrefixFromProviderKeys,
  migrateStripPlaceholderSentinelsFromMessages,
  migrateStripThinkingFromConsolidated,
  migrateToolInvocationsCreatedAtIdIndex,
  migrateToolInvocationsMatchedRuleId,
  migrateToolInvocationsSkillId,
  migrateToolInvocationsTelemetryColumns,
  migrateTraceEventsCreatedAtIndex,
  migrateUsageDashboardIndexes,
  migrateUsageLlmCallCount,
  migrateVoiceInviteColumns,
  migrateVoiceInviteDisplayMetadata,
  migrateWorkflowJournalLeafTokens,
  migrateWorkflowRuns,
  migrateWorkflowRunTrust,
  validateMigrationState,
} from "./migrations/index.js";
import { runMigrationSteps } from "./migrations/run-migrations.js";

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

/**
 * Template path for the attached `logs` database, kept alongside the main
 * template. Both files must be captured/restored together: the migrated state
 * now spans two files (llm_request_logs and its indexes live in `logs`), so
 * restoring only the main DB would leave a fresh, empty logs DB with no
 * `llm_request_logs` table.
 */
function getLogsTemplateDbPath(): string {
  return `${getTemplateDbPath()}.logs`;
}

function tryRestoreTemplate(): boolean {
  const templatePath = getTemplateDbPath();
  if (!existsSync(templatePath)) return false;
  // getDb() hasn't run yet, so the data directory may not exist.
  ensureDataDir();
  copyFileSync(templatePath, getDbPath());
  // Restore the attached logs DB before getDb() opens (and ATTACHes) it, so the
  // relocated llm_request_logs table is present. Older templates may predate
  // the split; the hash includes the migration files, so a stale template
  // without this sibling won't be reused — but guard anyway.
  const logsTemplate = getLogsTemplateDbPath();
  if (existsSync(logsTemplate)) {
    copyFileSync(logsTemplate, getLogsDbPath());
  }
  // Open the pre-migrated copy — getDb() will set PRAGMAs but skip migrations.
  getDb();
  return true;
}

function saveTemplate(): void {
  try {
    // Flush each DB's WAL to its main file before copying.
    getSqlite().exec("PRAGMA wal_checkpoint(TRUNCATE)");
    getSqlite().exec("PRAGMA logs.wal_checkpoint(TRUNCATE)");

    const mainTmp = `${getTemplateDbPath()}.${process.pid}`;
    copyFileSync(getDbPath(), mainTmp);
    const logsTmp = `${getLogsTemplateDbPath()}.${process.pid}`;
    copyFileSync(getLogsDbPath(), logsTmp);

    // Atomic renames — safe even with parallel test workers.
    renameSync(mainTmp, getTemplateDbPath());
    renameSync(logsTmp, getLogsTemplateDbPath());
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
    migrateCoreTables,
    createWatchersAndLogsTables,
    addCoreColumns,
    ...complexMigrationSteps,
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
    ...lateMigrationSteps,
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
    createApprovalPromptTsTrackerTable,
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
    migrateScheduleScriptColumn,
    migrateMemoryRecallLogsQueryContext,
    migrateLlmRequestLogsCreatedAtIndex,
    migrateOAuthProvidersScopeSeparator,
    migrateOAuthProvidersRefreshUrl,
    migrateOAuthProvidersRevoke,
    migrateOAuthProvidersTokenAuthMethodDefault,
    migrateConversationHostAccess,
    migrateOAuthProvidersLogoUrl,
    migrateOAuthProvidersTokenExchangeBodyFormat,
    migrateNormalizeUserFileByPrincipal,
    migrateConversationsArchivedAt,
    migrateStripPlaceholderSentinelsFromMessages,
    migrateOAuthProvidersManagedServiceIsPaid,
    migrateOAuthProvidersAvailableScopes,
    migrateScheduleWakeConversationId,
    migrateAddConversationInferenceProfile,
    migrateRenameInferenceProfileSnakeCase,
    migrateDeletePrivateConversations,
    migrate230AcpSessionHistory,
    migrate231RepairMemoryGraphEventDates,
    migrateActivationState,
    migrateActivationStateFkCascade,
    migrateMemoryV2ActivationLogs,
    migrateCreateDocumentConversations,
    migrateLlmUsageAttribution,
    migrateSlackCompactionWatermark,
    migrateToolInvocationsMatchedRuleId,
    migrateHeartbeatRuns,
    function migrateBackfillAppConversationIds() {
      backfillAppConversationIds();
    },
    migrateScheduleRetryPolicy,
    migrateTraceEventsCreatedAtIndex,
    migrateConversationInferenceProfileSession,
    migrateMessageBookmarks,
    migrateCreateProviderConnections,
    migrateProviderConnectionStatusLabel,
    migrateMemoryRetrospectiveState,
    migrateBackfillProviderConnectionLabel,
    migrateExternalConversationBindingThreadId,
    createOnboardingEventsTable,
    migrateNormalizeSlackExternalContent,
    migrateProviderConnectionBaseUrlAndModels,
    migrateA2ATasks,
    migrateLlmRequestLogAgentLoopExitReason,
    migrateCreateDocumentComments,
    migrateExternalConversationBindingChatName,
    migrateChannelInboundDeliveryAttempts,
    migrateMemoryV2InjectionEvents,
    migrateConversationLastNotifiedProfile,
    migrateStripBaseUrlNonOpenaiCompatible,
    migrateOnboardingEventsPriorAssistants,
    migrateConversationCleanedAt,
    migrateRenameCleanedAt,
    migrateLlmUsageAddRawUsage,
    migrateMemoryV3Coactivation,
    migrateMemoryV3AutoEdges,
    migrateLlmRequestLogCallSite,
    migrateDropProviderConnectionStatus,
    migrateMessagesClientMessageId,
    migrateLlmUsageEventsAddAssistantVersion,
    migrateAddMemoryV3Selections,
    migrateScheduleScriptTimeout,
    migrateScheduleDescription,
    migrateScheduleSourceConversation,
    migrateMessagesRoleCreatedAtIndex,
    createAuthFallbackEventsTable,
    migrateAcpSessionHistoryCwd,
    migrateOnboardingEventsFunnelColumns,
    createActivationSessionsTable,
    migrateToolInvocationsSkillId,
    migrateToolInvocationsCreatedAtIdIndex,
    migrateAddMemoryV3EverInjected,
    migrateToolInvocationsTelemetryColumns,
    createSkillLoadedEventsTable,
    migrateConversationsSurfacedAt,
    migrateMemoryRetrospectiveRememberedLog,
    migrateScheduleInferenceProfile,
    migrateMemoryV3SelectionsMessageIdAndSections,
    migrateWorkflowRuns,
    migrateScheduleWorkflowMode,
    migrateWorkflowRunTrust,
    migrateConversationOriginChannelIndex,
    migrateBackfillOriginChannelFromBindings,
    migrateContactChannelsUniqueExtUser,
    migrateScheduleCapabilities,
    migrateContactChannelsRenormalizeAddresses,
    migrateScheduleDefaultNoReuseConversation,
    migrateWorkflowJournalLeafTokens,
    migrateDropExternalUserId,
    dropApprovalPromptTsTrackerTable,
    migrateRewriteBalancedEconomyProfilePins,
    migrateMoveLlmRequestLogsToLogsDb,
  ];

  // Run each migration step, catching and logging individual failures so one
  // broken migration doesn't prevent independent later ones from succeeding.
  // The runner creates the checkpoint ledger, recovers crashed migrations, then
  // records each step so an already-migrated database skips it on later boots.
  const { failed, skipped } = runMigrationSteps(database, migrationSteps);

  log.debug(
    {
      ranCount: migrationSteps.length - skipped.length,
      skipped: skipped.length,
    },
    `DB migration steps complete (${skipped.length} skipped via checkpoint)`,
  );

  if (failed.length > 0) {
    log.error(
      { failedMigrations: failed, count: failed.length },
      `DB initialization completed with ${failed.length} failed migration(s)`,
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

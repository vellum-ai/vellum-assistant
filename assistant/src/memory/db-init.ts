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
import { getMemoryDbPath } from "../util/memory-db-path.js";
import { ensureDataDir, getDbPath } from "../util/platform.js";
import { backfillAppConversationIds } from "./app-store.js";
import { runAsyncSqlite } from "./db-async-query.js";
import {
  getDb,
  getLogsSqlite,
  getMemorySqlite,
  getSqlite,
} from "./db-connection.js";
import { migrateToolCreatedItems } from "./graph/bootstrap.js";
import { migrateCoreTables } from "./migrations/000-core-tables.js";
import { migrateJobDeferrals } from "./migrations/001-job-deferrals.js";
import { migrateToolInvocationsFk } from "./migrations/002-tool-invocations-fk.js";
import { migrateMemoryFtsBackfill } from "./migrations/003-memory-fts-backfill.js";
import { migrateMemoryEntityRelationDedup } from "./migrations/004-entity-relation-dedup.js";
import { migrateMemoryItemsFingerprintScopeUnique } from "./migrations/005-fingerprint-scope-unique.js";
import { migrateMemoryItemsScopeSaltedFingerprints } from "./migrations/006-scope-salted-fingerprints.js";
import { migrateAssistantIdToSelf } from "./migrations/007-assistant-id-to-self.js";
import { migrateRemoveAssistantIdColumns } from "./migrations/008-remove-assistant-id-columns.js";
import { migrateLlmUsageEventsDropAssistantId } from "./migrations/009-llm-usage-events-drop-assistant-id.js";
import { migrateGuardianActionTables } from "./migrations/013-guardian-action-tables.js";
import { migrateMemorySegmentsIndexes } from "./migrations/016-memory-segments-indexes.js";
import { migrateMemoryItemsIndexes } from "./migrations/017-memory-items-indexes.js";
import { migrateRemainingTableIndexes } from "./migrations/018-remaining-table-indexes.js";
import { migrateRenameChannelToVellum } from "./migrations/020-rename-macos-ios-channel-to-vellum.js";
import { migrateConversationStatusIndexes } from "./migrations/021-conversation-status-indexes.js";
import { migrateAddOriginInterface } from "./migrations/022-add-origin-interface.js";
import { migrateMemoryItemSourcesIndexes } from "./migrations/023-memory-item-sources-indexes.js";
import { migrateEmbeddingVectorBlob } from "./migrations/024-embedding-vector-blob.js";
import { migrateMessagesFtsBackfill } from "./migrations/025-messages-fts-backfill.js";
import { migrateGuardianVerificationSessions } from "./migrations/026-guardian-verification-sessions.js";
import { migrateEmbeddingsNullableVectorJson } from "./migrations/026a-embeddings-nullable-vector-json.js";
import { migrateGuardianBootstrapToken } from "./migrations/027a-guardian-bootstrap-token.js";
import { migrateCallSessionMode } from "./migrations/028-call-session-mode.js";
import { migrateChannelInboundDeliveredSegments } from "./migrations/029-channel-inbound-delivered-segments.js";
import { migrateGuardianActionFollowup } from "./migrations/030-guardian-action-followup.js";
import { migrateGuardianVerificationPurpose } from "./migrations/030-guardian-verification-purpose.js";
import { migrateConversationsThreadTypeIndex } from "./migrations/031-conversations-thread-type-index.js";
import { migrateGuardianDeliveryConversationIndex } from "./migrations/032-guardian-delivery-conversation-index.js";
import { migrateNotificationDeliveryThreadDecision } from "./migrations/032-notification-delivery-thread-decision.js";
import { createScopedApprovalGrantsTable } from "./migrations/033-scoped-approval-grants.js";
import { migrateGuardianActionToolMetadata } from "./migrations/034-guardian-action-tool-metadata.js";
import { migrateGuardianActionSupersession } from "./migrations/035-guardian-action-supersession.js";
import { migrateNormalizePhoneIdentities } from "./migrations/036-normalize-phone-identities.js";
import { migrateVoiceInviteColumns } from "./migrations/037-voice-invite-columns.js";
import { migrateInviteCodeHashColumn } from "./migrations/040-invite-code-hash-column.js";
import { createApprovalPromptTsTrackerTable } from "./migrations/041-approval-prompt-ts-tracker.js";
import { createWatchersAndLogsTables } from "./migrations/101-watchers-and-logs.js";
import { addCoreColumns } from "./migrations/102-alter-table-columns.js";
import { createCoreIndexes } from "./migrations/104-core-indexes.js";
import { createContactsAndTriageTables } from "./migrations/105-contacts-and-triage.js";
import { createCallSessionsTables } from "./migrations/106-call-sessions.js";
import { createFollowupsTables } from "./migrations/107-followups.js";
import { createTasksAndWorkItemsTables } from "./migrations/108-tasks-and-work-items.js";
import { createExternalConversationBindingsTables } from "./migrations/109-external-conversation-bindings.js";
import { createChannelGuardianTables } from "./migrations/110-channel-guardian.js";
import { createMediaAssetsTables } from "./migrations/111-media-assets.js";
import { createAssistantInboxTables } from "./migrations/112-assistant-inbox.js";
import { createNotificationTables } from "./migrations/114-notifications.js";
import { createSequenceTables } from "./migrations/115-sequences.js";
import { createMessagesFts } from "./migrations/116-messages-fts.js";
import { createConversationAttentionTables } from "./migrations/117-conversation-attention.js";
import { migrateReminderRoutingIntent } from "./migrations/118-reminder-routing-intent.js";
import { migrateSchemaIndexesAndColumns } from "./migrations/119-schema-indexes-and-columns.js";
import { migrateFkCascadeRebuilds } from "./migrations/120-fk-cascade-rebuilds.js";
import { createCanonicalGuardianTables } from "./migrations/121-canonical-guardian-requests.js";
import { migrateCanonicalGuardianRequesterChatId } from "./migrations/122-canonical-guardian-requester-chat-id.js";
import { migrateCanonicalGuardianDeliveriesDestinationIndex } from "./migrations/123-canonical-guardian-deliveries-destination-index.js";
import { migrateVoiceInviteDisplayMetadata } from "./migrations/124-voice-invite-display-metadata.js";
import { migrateGuardianPrincipalIdColumns } from "./migrations/125-guardian-principal-id-columns.js";
import { migrateBackfillGuardianPrincipalId } from "./migrations/126-backfill-guardian-principal-id.js";
import { migrateGuardianPrincipalIdNotNull } from "./migrations/127-guardian-principal-id-not-null.js";
import { migrateContactsRolePrincipal } from "./migrations/128-contacts-role-principal.js";
import { migrateContactChannelsAccessFields } from "./migrations/129-contact-channels-access-fields.js";
import { migrateContactChannelsTypeChatIdIndex } from "./migrations/130-contact-channels-type-ext-chat-id-index.js";
import { migrateDropLegacyMemberGuardianTables } from "./migrations/131-drop-legacy-member-guardian-tables.js";
import { migrateContactsAssistantId } from "./migrations/132-contacts-assistant-id.js";
import { migrateAssistantContactMetadata } from "./migrations/133-assistant-contact-metadata.js";
import { migrateContactsNotesColumn } from "./migrations/134-contacts-notes-column.js";
import { migrateBackfillContactInteractionStats } from "./migrations/135-backfill-contact-interaction-stats.js";
import { migrateDropAssistantIdColumns } from "./migrations/136-drop-assistant-id-columns.js";
import { migrateUsageDashboardIndexes } from "./migrations/137-usage-dashboard-indexes.js";
import { migrateDropUsageCompositeIndexes } from "./migrations/139-drop-usage-composite-indexes.js";
import { migrateBackfillUsageCacheAccounting } from "./migrations/140-backfill-usage-cache-accounting.js";
import { migrateRenameVerificationTable } from "./migrations/141-rename-verification-table.js";
import { migrateRenameVerificationSessionIdColumn } from "./migrations/142-rename-verification-session-id-column.js";
import { migrateRenameGuardianVerificationValues } from "./migrations/143-rename-guardian-verification-values.js";
import { migrateRenameVoiceToPhone } from "./migrations/144-rename-voice-to-phone.js";
import { migrateDropAccountsTable } from "./migrations/145-drop-accounts-table.js";
import { migrateScheduleOneShotRouting } from "./migrations/146-schedule-oneshot-routing.js";
import { migrateRemindersToSchedules } from "./migrations/147-migrate-reminders-to-schedules.js";
import { migrateDropRemindersTable } from "./migrations/148-drop-reminders-table.js";
import { createOAuthTables } from "./migrations/149-oauth-tables.js";
import { migrateOAuthAppsClientSecretPath } from "./migrations/150-oauth-apps-client-secret-path.js";
import { migrateOAuthProvidersPingUrl } from "./migrations/151-oauth-providers-ping-url.js";
import { migrateMemoryItemSupersession } from "./migrations/152-memory-item-supersession.js";
import { migrateDropEntityTables } from "./migrations/153-drop-entity-tables.js";
import { migrateDropMemorySegmentFts } from "./migrations/154-drop-fts.js";
import { migrateDropConflicts } from "./migrations/155-drop-conflicts.js";
import { migrateCallSessionInviteMetadata } from "./migrations/156-call-session-invite-metadata.js";
import { migrateInviteContactId } from "./migrations/157-invite-contact-id.js";
import { migrateChannelInteractionColumns } from "./migrations/158-channel-interaction-columns.js";
import { migrateDropContactInteractionColumns } from "./migrations/159-drop-contact-interaction-columns.js";
import { migrateDropLoopbackPortColumn } from "./migrations/160-drop-loopback-port-column.js";
import { migrateDropOrphanedMediaTables } from "./migrations/161-drop-orphaned-media-tables.js";
import { migrateGuardianTimestampsEpochMs } from "./migrations/162-guardian-timestamps-epoch-ms.js";
import { migrateRenameNotificationThreadColumns } from "./migrations/163-rename-notification-thread-columns.js";
import { migrateRenameConversationTypeColumn } from "./migrations/164-rename-conversation-type-column.js";
import { migrateRenameInboxThreadStateTable } from "./migrations/165-rename-inbox-thread-state-table.js";
import { migrateRenameFollowupsThreadIdColumn } from "./migrations/166-rename-followups-thread-id.js";
import { migrateRenameSequenceEnrollmentsThreadIdColumn } from "./migrations/167-rename-sequence-enrollments-thread-id.js";
import { migrateRenameSequenceStepsReplyKey } from "./migrations/168-rename-sequence-steps-reply-key.js";
import { migrateRenameGmailProviderKeyToGoogle } from "./migrations/169-rename-gmail-provider-key-to-google.js";
import { migrateCreateThreadStartersTable } from "./migrations/170-thread-starters-table.js";
import { migrateCapabilityCardColumns } from "./migrations/171-capability-card-columns.js";
import { migrateRenameCreatedBySessionIdColumns } from "./migrations/172-rename-created-by-session-id.js";
import { migrateRenameSourceSessionIdColumn } from "./migrations/173-rename-source-session-id.js";
import { migrateRenameThreadStartersTable } from "./migrations/174-rename-thread-starters-table.js";
import { createLifecycleEventsTable } from "./migrations/175-create-lifecycle-events.js";
import { migrateDropCapabilityCardState } from "./migrations/176-drop-capability-card-state.js";
import { migrateCreateTraceEventsTable } from "./migrations/177-create-trace-events-table.js";
import { migrateOAuthProvidersManagedServiceConfigKey } from "./migrations/178-oauth-providers-managed-service-config-key.js";
import { migrateLlmRequestLogMessageId } from "./migrations/179-llm-request-log-message-id.js";
import { migrateBackfillInlineAttachmentsToDisk } from "./migrations/180-backfill-inline-attachments-to-disk.js";
import { migrateRenameThreadStartersCheckpoints } from "./migrations/181-rename-thread-starters-checkpoints.js";
import { migrateOAuthProvidersDisplayMetadata } from "./migrations/182-oauth-providers-display-metadata.js";
import { migrateConversationForkLineage } from "./migrations/183-add-conversation-fork-lineage.js";
import { migrateLlmRequestLogProvider } from "./migrations/184-llm-request-log-provider.js";
import { migrateScheduleQuietFlag } from "./migrations/188-schedule-quiet-flag.js";
import { migrateDropSimplifiedMemory } from "./migrations/189-drop-simplified-memory.js";
import { migrateCallSessionSkipDisclosure } from "./migrations/190-call-session-skip-disclosure.js";
import { migrateBackfillAudioAttachmentMimeTypes } from "./migrations/191-backfill-audio-attachment-mime-types.js";
import { migrateContactsUserFileColumn } from "./migrations/192-contacts-user-file-column.js";
import { migrateAddSourceTypeColumns } from "./migrations/193-add-source-type-columns.js";
import { migrateCreateMemoryRecallLogs } from "./migrations/194-memory-recall-logs.js";
import { migrateOAuthProvidersPingConfig } from "./migrations/195-oauth-providers-ping-config.js";
import { migrateMessagesConversationCreatedAtIndex } from "./migrations/196-messages-conversation-created-at-index.js";
import { migrateStripIntegrationPrefixFromProviderKeys } from "./migrations/196-strip-integration-prefix-from-provider-keys.js";
import { migrateOAuthProvidersBehaviorColumns } from "./migrations/197-oauth-providers-behavior-columns.js";
import { migrateDropSetupSkillIdColumn } from "./migrations/198-drop-setup-skill-id-column.js";
import { migrateGuardianRequestEnrichmentColumns } from "./migrations/199-guardian-request-enrichment-columns.js";
import { migrateUsageLlmCallCount } from "./migrations/200-usage-llm-call-count.js";
import { migrateOAuthProvidersFeatureFlag } from "./migrations/201-oauth-providers-feature-flag.js";
import { migrateDropCallbackTransportColumn } from "./migrations/202-drop-callback-transport-column.js";
import { migrateCreateMemoryGraphTables } from "./migrations/202-memory-graph-tables.js";
import { migrateDropMemoryItemsTables } from "./migrations/203-drop-memory-items-tables.js";
import { migrateRenameMemoryGraphTypeValues } from "./migrations/204-rename-memory-graph-type-values.js";
import { migrateMemoryGraphImageRefs } from "./migrations/205-memory-graph-image-refs.js";
import { migrateCreateMemoryGraphNodeEdits } from "./migrations/206-memory-graph-node-edits.js";
import { migrateScrubCorruptedImageAttachments } from "./migrations/206-scrub-corrupted-image-attachments.js";
import { migrateCreateConversationGraphMemoryState } from "./migrations/207-conversation-graph-memory-state.js";
import { migrateConversationsLastMessageAt } from "./migrations/208-conversations-last-message-at.js";
import { migrateStripThinkingFromConsolidated } from "./migrations/209-strip-thinking-from-consolidated.js";
import { migrateScheduleReuseConversation } from "./migrations/210-schedule-reuse-conversation.js";
import { migrateMemoryRecallLogsQueryContext } from "./migrations/211-memory-recall-logs-query-context.js";
import { migrateLlmRequestLogsCreatedAtIndex } from "./migrations/212-llm-request-logs-created-at-index.js";
import { migrateOAuthProvidersScopeSeparator } from "./migrations/213-oauth-providers-scope-separator.js";
import { migrateOAuthProvidersRefreshUrl } from "./migrations/214-oauth-providers-refresh-url.js";
import { migrateOAuthProvidersRevoke } from "./migrations/215-oauth-providers-revoke.js";
import { migrateOAuthProvidersTokenAuthMethodDefault } from "./migrations/216-oauth-providers-token-auth-method.js";
import { migrateConversationHostAccess } from "./migrations/217-conversation-host-access.js";
import { migrateOAuthProvidersLogoUrl } from "./migrations/218-oauth-providers-logo-url.js";
import { migrateOAuthProvidersTokenExchangeBodyFormat } from "./migrations/219-oauth-providers-token-exchange-body-format.js";
import { migrateNormalizeUserFileByPrincipal } from "./migrations/220-normalize-user-file-by-principal.js";
import { migrateConversationsArchivedAt } from "./migrations/221-conversations-archived-at.js";
import { migrateStripPlaceholderSentinelsFromMessages } from "./migrations/222-strip-placeholder-sentinels-from-messages.js";
import { migrateScheduleScriptColumn } from "./migrations/223-schedule-script-column.js";
import { migrateOAuthProvidersManagedServiceIsPaid } from "./migrations/224-oauth-providers-managed-service-is-paid.js";
import { migrateOAuthProvidersAvailableScopes } from "./migrations/225-oauth-providers-available-scopes.js";
import { migrateScheduleWakeConversationId } from "./migrations/226-schedule-wake-conversation-id.js";
import { migrateAddConversationInferenceProfile } from "./migrations/227-add-conversation-inference-profile.js";
import { migrateRenameInferenceProfileSnakeCase } from "./migrations/228-rename-inference-profile-snake-case.js";
import { migrateDeletePrivateConversations } from "./migrations/229-delete-private-conversations.js";
import { migrate230AcpSessionHistory } from "./migrations/230-acp-session-history.js";
import { migrate231RepairMemoryGraphEventDates } from "./migrations/231-repair-memory-graph-event-dates.js";
import { migrateActivationState } from "./migrations/232-activation-state.js";
import { migrateCreateDocumentConversations } from "./migrations/233-document-conversations.js";
import { migrateMemoryV2ActivationLogs } from "./migrations/234-memory-v2-activation-logs.js";
import { migrateLlmUsageAttribution } from "./migrations/235-llm-usage-attribution.js";
import { migrateSlackCompactionWatermark } from "./migrations/235-slack-compaction-watermark.js";
import { migrateToolInvocationsMatchedRuleId } from "./migrations/236-tool-invocations-matched-rule-id.js";
import { migrateHeartbeatRuns } from "./migrations/237-heartbeat-runs.js";
import { migrateScheduleRetryPolicy } from "./migrations/238-schedule-retry-policy.js";
import { migrateTraceEventsCreatedAtIndex } from "./migrations/239-trace-events-created-at-index.js";
import { migrateConversationInferenceProfileSession } from "./migrations/240-conversation-inference-profile-session.js";
import { migrateActivationStateFkCascade } from "./migrations/241-activation-state-fk-cascade.js";
import { migrateMessageBookmarks } from "./migrations/242-message-bookmarks.js";
import { migrateCreateProviderConnections } from "./migrations/243-provider-connections.js";
import { migrateProviderConnectionStatusLabel } from "./migrations/244-provider-connection-status-label.js";
import { migrateMemoryRetrospectiveState } from "./migrations/245-memory-retrospective-state.js";
import { migrateBackfillProviderConnectionLabel } from "./migrations/246-backfill-provider-connection-label.js";
import { migrateExternalConversationBindingThreadId } from "./migrations/247-external-conversation-binding-thread-id.js";
import { createOnboardingEventsTable } from "./migrations/248-create-onboarding-events.js";
import { migrateNormalizeSlackExternalContent } from "./migrations/249-normalize-slack-external-content.js";
import { migrateProviderConnectionBaseUrlAndModels } from "./migrations/250-provider-connection-base-url-and-models.js";
import { migrateA2ATasks } from "./migrations/251-a2a-tasks.js";
import { migrateLlmRequestLogAgentLoopExitReason } from "./migrations/252-llm-request-log-agent-loop-exit-reason.js";
import { migrateConversationLastNotifiedProfile } from "./migrations/253-conversation-last-notified-profile.js";
import { migrateCreateDocumentComments } from "./migrations/253-document-comments.js";
import { migrateExternalConversationBindingChatName } from "./migrations/254-external-conversation-binding-chat-name.js";
import { migrateChannelInboundDeliveryAttempts } from "./migrations/255-channel-inbound-delivery-attempts.js";
import { migrateMemoryV2InjectionEvents } from "./migrations/256-memory-v2-injection-events.js";
import { migrateStripBaseUrlNonOpenaiCompatible } from "./migrations/257-strip-base-url-non-openai-compatible.js";
import { migrateOnboardingEventsPriorAssistants } from "./migrations/258-onboarding-events-prior-assistants.js";
import { migrateConversationCleanedAt } from "./migrations/259-conversation-cleaned-at.js";
import { migrateRenameCleanedAt } from "./migrations/260-rename-cleaned-at.js";
import { migrateLlmUsageAddRawUsage } from "./migrations/261-llm-usage-add-raw-usage.js";
import { migrateMemoryV3Coactivation } from "./migrations/262-memory-v3-coactivation.js";
import { migrateMemoryV3AutoEdges } from "./migrations/263-memory-v3-auto-edges.js";
import { migrateLlmRequestLogCallSite } from "./migrations/264-llm-request-log-call-site.js";
import { migrateDropProviderConnectionStatus } from "./migrations/265-drop-provider-connection-status.js";
import { migrateMessagesClientMessageId } from "./migrations/266-messages-client-message-id.js";
import { migrateLlmUsageEventsAddAssistantVersion } from "./migrations/267-llm-usage-events-add-assistant-version.js";
import { migrateAddMemoryV3Selections } from "./migrations/268-add-memory-v3-selections.js";
import { migrateScheduleScriptTimeout } from "./migrations/269-schedule-script-timeout.js";
import { migrateMessagesRoleCreatedAtIndex } from "./migrations/270-messages-role-created-at-index.js";
import { migrateScheduleDescription } from "./migrations/270-schedule-description.js";
import { migrateScheduleSourceConversation } from "./migrations/270-schedule-source-conversation.js";
import { createAuthFallbackEventsTable } from "./migrations/271-create-auth-fallback-events.js";
import { migrateAcpSessionHistoryCwd } from "./migrations/272-acp-session-history-cwd.js";
import { migrateOnboardingEventsFunnelColumns } from "./migrations/273-onboarding-events-funnel-columns.js";
import { createActivationSessionsTable } from "./migrations/274-create-activation-sessions.js";
import { migrateToolInvocationsSkillId } from "./migrations/275-tool-invocations-add-skill-id.js";
import { migrateToolInvocationsCreatedAtIdIndex } from "./migrations/276-tool-invocations-created-at-id-index.js";
import { migrateAddMemoryV3EverInjected } from "./migrations/277-add-memory-v3-ever-injected.js";
import { migrateToolInvocationsTelemetryColumns } from "./migrations/278-tool-invocations-telemetry-columns.js";
import { createSkillLoadedEventsTable } from "./migrations/279-create-skill-loaded-events.js";
import { migrateConversationsSurfacedAt } from "./migrations/280-conversations-surfaced-at.js";
import { migrateMemoryRetrospectiveRememberedLog } from "./migrations/281-memory-retrospective-remembered-log.js";
import { migrateScheduleInferenceProfile } from "./migrations/282-schedule-inference-profile.js";
import { migrateMemoryV3SelectionsMessageIdAndSections } from "./migrations/283-memory-v3-selections-message-id-and-sections.js";
import { migrateWorkflowRuns } from "./migrations/284-workflow-runs.js";
import { migrateScheduleWorkflowMode } from "./migrations/285-schedule-workflow-mode.js";
import { migrateWorkflowRunTrust } from "./migrations/286-workflow-run-trust.js";
import { migrateConversationOriginChannelIndex } from "./migrations/287-conversation-origin-channel-index.js";
import { migrateBackfillOriginChannelFromBindings } from "./migrations/288-backfill-origin-channel-from-bindings.js";
import { migrateContactChannelsUniqueExtUser } from "./migrations/289-contact-channels-unique-ext-user.js";
import { migrateScheduleCapabilities } from "./migrations/290-schedule-capabilities.js";
import { migrateContactChannelsRenormalizeAddresses } from "./migrations/291-contact-channels-renormalize-addresses.js";
import { migrateScheduleDefaultNoReuseConversation } from "./migrations/292-schedule-default-no-reuse-conversation.js";
import { migrateWorkflowJournalLeafTokens } from "./migrations/293-workflow-journal-leaf-tokens.js";
import { migrateDropExternalUserId } from "./migrations/294-drop-external-user-id.js";
import { dropApprovalPromptTsTrackerTable } from "./migrations/295-drop-approval-prompt-ts-tracker.js";
import { migrateRewriteBalancedEconomyProfilePins } from "./migrations/296-rewrite-balanced-economy-profile-pins.js";
import { migrateMoveLlmRequestLogsToLogsDb } from "./migrations/297-move-llm-request-logs-to-logs-db.js";
import { migrateMoveMemoryJobsToMemoryDb } from "./migrations/298-move-memory-jobs-to-memory-db.js";
import { dropChannelGuardianApprovalRequestsTable } from "./migrations/299-drop-channel-guardian-approval-requests.js";
import { runMigrationSteps } from "./migrations/run-migrations.js";
import { validateMigrationState } from "./migrations/validate-migration-state.js";

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
 * Template path for the dedicated `logs` database, kept alongside the main
 * template. All three files must be captured/restored together: the migrated
 * state spans them (llm_request_logs and its indexes live in `logs`), so
 * restoring only the main DB would leave a fresh, empty logs DB with no
 * `llm_request_logs` table.
 */
function getLogsTemplateDbPath(): string {
  return `${getTemplateDbPath()}.logs`;
}

/**
 * Template path for the dedicated `memory` database, kept alongside the main
 * and logs templates. Captured/restored together with them so the restored
 * test DB includes `memory_jobs` (created by migration 298 in this file).
 */
function getMemoryTemplateDbPath(): string {
  return `${getTemplateDbPath()}.memory`;
}

function tryRestoreTemplate(): boolean {
  const templatePath = getTemplateDbPath();
  const logsTemplate = getLogsTemplateDbPath();
  const memoryTemplate = getMemoryTemplateDbPath();
  // Restore only when ALL THREE templates are present. `saveTemplate()` renames
  // them one at a time, so a parallel test worker can momentarily observe the
  // main template without its logs/memory siblings. Restoring then would copy
  // the main DB, leave the dedicated DBs as fresh empty files, and skip
  // migrations — so the next `llm_request_logs`/`memory_jobs` access would fail
  // with a missing-table error. Treating a partial set as "not ready" makes such
  // a worker fall through to a full migrate, which creates every table.
  if (
    !existsSync(templatePath) ||
    !existsSync(logsTemplate) ||
    !existsSync(memoryTemplate)
  ) {
    return false;
  }
  // getDb() hasn't run yet, so the data directory may not exist.
  ensureDataDir();
  copyFileSync(templatePath, getDbPath());
  // Restore the dedicated logs/memory DBs before their connections open, so the
  // relocated tables are present.
  copyFileSync(logsTemplate, getLogsDbPath());
  copyFileSync(memoryTemplate, getMemoryDbPath());
  // Open the pre-migrated copy — getDb() will set PRAGMAs but skip migrations.
  getDb();
  return true;
}

function saveTemplate(): void {
  try {
    // Flush each connection's WAL to its main file before copying.
    getSqlite().exec("PRAGMA wal_checkpoint(TRUNCATE)");
    getLogsSqlite()?.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    getMemorySqlite()?.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    const mainTmp = `${getTemplateDbPath()}.${process.pid}`;
    copyFileSync(getDbPath(), mainTmp);
    const logsTmp = `${getLogsTemplateDbPath()}.${process.pid}`;
    copyFileSync(getLogsDbPath(), logsTmp);
    const memoryTmp = `${getMemoryTemplateDbPath()}.${process.pid}`;
    copyFileSync(getMemoryDbPath(), memoryTmp);

    // Atomic renames — safe even with parallel test workers.
    renameSync(mainTmp, getTemplateDbPath());
    renameSync(logsTmp, getLogsTemplateDbPath());
    renameSync(memoryTmp, getMemoryTemplateDbPath());
  } catch {
    // Best effort — next file will just run migrations normally.
  }
}

// ---------------------------------------------------------------------------

/**
 * Off-thread WAL checkpoint, run *before* the first in-process DB open.
 *
 * After an unclean shutdown (SIGKILL from OOM or a failed liveness probe) the
 * WAL is never folded back into the main database — the graceful checkpoint in
 * `shutdown-handlers.ts` is skipped — so it can grow to hundreds of MB across
 * crash-restarts. The first in-process `getDb()` open then runs SQLite WAL
 * recovery synchronously on the main thread (`bun:sqlite` is blocking),
 * stalling the event loop — including `/healthz` — for the full multi-minute
 * scan. That trips the liveness probe and crashloops the pod.
 *
 * Running `wal_checkpoint(TRUNCATE)` through the `sqlite3` subprocess
 * (`runAsyncSqlite`) first performs that recovery + fold + truncate off the
 * event loop, so the subsequent `getDb()` open finds an empty WAL and returns
 * cheaply. We keep `runAsyncSqlite`'s long default timeout deliberately:
 * because the checkpoint runs off the event loop it never blocks `/healthz`,
 * so a large WAL is allowed to flush for as long as it needs rather than
 * timing out and falling back to a blocking open.
 *
 * Best-effort and non-fatal: on any failure (no `sqlite3` binary, lock
 * contention, timeout) we return and let the caller open normally — a blocking
 * recovery, i.e. exactly the prior behavior, never worse. The caller skips
 * this entirely in tests (see `initializeDb`): un-awaited test callers rely on
 * the synchronous prefix of `initializeDb` creating the DB file before the
 * first yield, so no `await` may precede `getDb()` there.
 */
export async function checkpointWalBeforeOpen(): Promise<void> {
  const log = getLogger("db-init");
  try {
    const result = await runAsyncSqlite("PRAGMA wal_checkpoint(TRUNCATE)");
    if (result.ok) {
      log.info(
        { backend: result.backend, elapsedMs: result.elapsedMs },
        "Pre-open WAL checkpoint complete",
      );
    } else {
      log.warn(
        {
          backend: result.backend,
          elapsedMs: result.elapsedMs,
          timedOut: result.timedOut,
          error: result.error,
        },
        "Pre-open WAL checkpoint failed — proceeding to blocking open",
      );
    }
  } catch (err) {
    log.warn(
      { err },
      "Pre-open WAL checkpoint threw — proceeding to blocking open",
    );
  }
}

// ---------------------------------------------------------------------------

export async function initializeDb(): Promise<void> {
  if (process.env.BUN_TEST === "1" && tryRestoreTemplate()) {
    return;
  }

  // Fold any post-crash WAL back into the database off the main event loop
  // before the first open, so a large WAL can't block /healthz through a
  // synchronous in-process WAL recovery and trip the liveness probe.
  //
  // Guarded so it does not even *await* in tests: `bun test` (NODE_ENV=test)
  // callers invoke initializeDb() un-awaited and depend on getDb() (below)
  // creating the DB file during the synchronous prefix, before the first
  // yield. Any await ahead of getDb() would defer that and break them.
  if (process.env.BUN_TEST !== "1" && process.env.NODE_ENV !== "test") {
    await checkpointWalBeforeOpen();
  }

  const log = getLogger("db-init");
  const database = getDb();

  // Every migration step, in execution order. Each function accepts a
  // DrizzleDb and is identified by its .name.
  const migrationSteps = [
    migrateCoreTables,
    createWatchersAndLogsTables,
    addCoreColumns,
    migrateJobDeferrals,
    migrateToolInvocationsFk,
    migrateMemoryEntityRelationDedup,
    migrateMemoryItemsFingerprintScopeUnique,
    migrateMemoryItemsScopeSaltedFingerprints,
    migrateAssistantIdToSelf,
    migrateRemoveAssistantIdColumns,
    migrateLlmUsageEventsDropAssistantId,
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
    migrateGuardianActionTables,
    migrateMemoryFtsBackfill,
    migrateMemorySegmentsIndexes,
    migrateMemoryItemsIndexes,
    migrateRemainingTableIndexes,
    migrateRenameChannelToVellum,
    migrateConversationStatusIndexes,
    migrateAddOriginInterface,
    migrateMemoryItemSourcesIndexes,
    migrateEmbeddingVectorBlob,
    migrateEmbeddingsNullableVectorJson,
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
    migrateMoveMemoryJobsToMemoryDb,
    dropChannelGuardianApprovalRequestsTable,
  ];

  // Run each migration step, catching and logging individual failures so one
  // broken migration doesn't prevent independent later ones from succeeding.
  // The runner creates the checkpoint ledger, recovers crashed migrations, then
  // records each step so an already-migrated database skips it on later boots.
  const { applied, failed, skipped } = await runMigrationSteps(
    database,
    migrationSteps,
  );

  log.info(
    {
      applied: applied.length,
      skipped: skipped.length,
      total: migrationSteps.length,
    },
    `DB migration steps complete (${applied.length} applied, ${skipped.length} skipped via checkpoint)`,
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

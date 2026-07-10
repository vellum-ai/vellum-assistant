/**
 * The ordered list of all migration steps.
 *
 * Each step is either a bare function (identified by Function.name for
 * checkpointing) or an object carrying optional `rollback` and `dependsOn`
 * metadata. Rollback metadata was previously maintained in a separate
 * registry.ts file; it now lives inline with the step it applies to.
 */

import { backfillAppConversationIds } from "../apps/app-store.js";
// Forward migration + down function imports
import { migrateToolCreatedItems } from "../plugins/defaults/memory/graph/bootstrap.js";
import { migrateCoreTables } from "./migrations/000-core-tables.js";
import {
  downJobDeferrals,
  migrateJobDeferrals,
} from "./migrations/001-job-deferrals.js";
import { migrateToolInvocationsFk } from "./migrations/002-tool-invocations-fk.js";
import { migrateMemoryFtsBackfill } from "./migrations/003-memory-fts-backfill.js";
import {
  downMemoryEntityRelationDedup,
  migrateMemoryEntityRelationDedup,
} from "./migrations/004-entity-relation-dedup.js";
import {
  downMemoryItemsFingerprintScopeUnique,
  migrateMemoryItemsFingerprintScopeUnique,
} from "./migrations/005-fingerprint-scope-unique.js";
import {
  downMemoryItemsScopeSaltedFingerprints,
  migrateMemoryItemsScopeSaltedFingerprints,
} from "./migrations/006-scope-salted-fingerprints.js";
import {
  downAssistantIdToSelf,
  migrateAssistantIdToSelf,
} from "./migrations/007-assistant-id-to-self.js";
import {
  downRemoveAssistantIdColumns,
  migrateRemoveAssistantIdColumns,
} from "./migrations/008-remove-assistant-id-columns.js";
import {
  downLlmUsageEventsDropAssistantId,
  migrateLlmUsageEventsDropAssistantId,
} from "./migrations/009-llm-usage-events-drop-assistant-id.js";
import { migrateGuardianActionTables } from "./migrations/013-guardian-action-tables.js";
import { downBackfillInboxThreadState } from "./migrations/014-backfill-inbox-thread-state.js";
import { downDropActiveSearchIndex } from "./migrations/015-drop-active-search-index.js";
import { migrateMemorySegmentsIndexes } from "./migrations/016-memory-segments-indexes.js";
import { migrateMemoryItemsIndexes } from "./migrations/017-memory-items-indexes.js";
import { migrateRemainingTableIndexes } from "./migrations/018-remaining-table-indexes.js";
import { downNotificationTablesSchema } from "./migrations/019-notification-tables-schema-migration.js";
import {
  downRenameChannelToVellum,
  migrateRenameChannelToVellum,
} from "./migrations/020-rename-macos-ios-channel-to-vellum.js";
import { migrateConversationStatusIndexes } from "./migrations/021-conversation-status-indexes.js";
import { migrateAddOriginInterface } from "./migrations/022-add-origin-interface.js";
import { migrateMemoryItemSourcesIndexes } from "./migrations/023-memory-item-sources-indexes.js";
import {
  downEmbeddingVectorBlob,
  migrateEmbeddingVectorBlob,
} from "./migrations/024-embedding-vector-blob.js";
import { migrateMessagesFtsBackfill } from "./migrations/025-messages-fts-backfill.js";
import { migrateGuardianVerificationSessions } from "./migrations/026-guardian-verification-sessions.js";
import {
  downEmbeddingsNullableVectorJson,
  migrateEmbeddingsNullableVectorJson,
} from "./migrations/026a-embeddings-nullable-vector-json.js";
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
import {
  downNormalizePhoneIdentities,
  migrateNormalizePhoneIdentities,
} from "./migrations/036-normalize-phone-identities.js";
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
import {
  downBackfillGuardianPrincipalId,
  migrateBackfillGuardianPrincipalId,
} from "./migrations/126-backfill-guardian-principal-id.js";
import {
  downGuardianPrincipalIdNotNull,
  migrateGuardianPrincipalIdNotNull,
} from "./migrations/127-guardian-principal-id-not-null.js";
import { migrateContactsRolePrincipal } from "./migrations/128-contacts-role-principal.js";
import { migrateContactChannelsAccessFields } from "./migrations/129-contact-channels-access-fields.js";
import { migrateContactChannelsTypeChatIdIndex } from "./migrations/130-contact-channels-type-ext-chat-id-index.js";
import { migrateDropLegacyMemberGuardianTables } from "./migrations/131-drop-legacy-member-guardian-tables.js";
import { migrateContactsAssistantId } from "./migrations/132-contacts-assistant-id.js";
import { migrateAssistantContactMetadata } from "./migrations/133-assistant-contact-metadata.js";
import {
  downContactsNotesColumn,
  migrateContactsNotesColumn,
} from "./migrations/134-contacts-notes-column.js";
import {
  downBackfillContactInteractionStats,
  migrateBackfillContactInteractionStats,
} from "./migrations/135-backfill-contact-interaction-stats.js";
import {
  downDropAssistantIdColumns,
  migrateDropAssistantIdColumns,
} from "./migrations/136-drop-assistant-id-columns.js";
import { migrateUsageDashboardIndexes } from "./migrations/137-usage-dashboard-indexes.js";
import { migrateDropUsageCompositeIndexes } from "./migrations/139-drop-usage-composite-indexes.js";
import {
  downBackfillUsageCacheAccounting,
  migrateBackfillUsageCacheAccounting,
} from "./migrations/140-backfill-usage-cache-accounting.js";
import {
  downRenameVerificationTable,
  migrateRenameVerificationTable,
} from "./migrations/141-rename-verification-table.js";
import {
  downRenameVerificationSessionIdColumn,
  migrateRenameVerificationSessionIdColumn,
} from "./migrations/142-rename-verification-session-id-column.js";
import {
  downRenameGuardianVerificationValues,
  migrateRenameGuardianVerificationValues,
} from "./migrations/143-rename-guardian-verification-values.js";
import {
  downRenameVoiceToPhone,
  migrateRenameVoiceToPhone,
} from "./migrations/144-rename-voice-to-phone.js";
import {
  migrateDropAccountsTable,
  migrateDropAccountsTableDown,
} from "./migrations/145-drop-accounts-table.js";
import { migrateScheduleOneShotRouting } from "./migrations/146-schedule-oneshot-routing.js";
import {
  migrateRemindersToSchedules,
  migrateRemindersToSchedulesDown,
} from "./migrations/147-migrate-reminders-to-schedules.js";
import {
  migrateDropRemindersTable,
  migrateDropRemindersTableDown,
} from "./migrations/148-drop-reminders-table.js";
import { createOAuthTables } from "./migrations/149-oauth-tables.js";
import {
  migrateOAuthAppsClientSecretPath,
  migrateOAuthAppsClientSecretPathDown,
} from "./migrations/150-oauth-apps-client-secret-path.js";
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
import {
  migrateGuardianTimestampsEpochMs,
  migrateGuardianTimestampsEpochMsDown,
  migrateGuardianTimestampsRebuildDown,
} from "./migrations/162-guardian-timestamps-epoch-ms.js";
import { migrateRenameNotificationThreadColumns } from "./migrations/163-rename-notification-thread-columns.js";
import { migrateRenameConversationTypeColumn } from "./migrations/164-rename-conversation-type-column.js";
import { migrateRenameInboxThreadStateTable } from "./migrations/165-rename-inbox-thread-state-table.js";
import { migrateRenameFollowupsThreadIdColumn } from "./migrations/166-rename-followups-thread-id.js";
import { migrateRenameSequenceEnrollmentsThreadIdColumn } from "./migrations/167-rename-sequence-enrollments-thread-id.js";
import { migrateRenameSequenceStepsReplyKey } from "./migrations/168-rename-sequence-steps-reply-key.js";
import {
  migrateRenameGmailProviderKeyToGoogle,
  migrateRenameGmailProviderKeyToGoogleDown,
} from "./migrations/169-rename-gmail-provider-key-to-google.js";
import { migrateCreateThreadStartersTable } from "./migrations/170-thread-starters-table.js";
import { migrateCapabilityCardColumns } from "./migrations/171-capability-card-columns.js";
import { migrateRenameCreatedBySessionIdColumns } from "./migrations/172-rename-created-by-session-id.js";
import { migrateRenameSourceSessionIdColumn } from "./migrations/173-rename-source-session-id.js";
import {
  migrateRenameThreadStartersTable,
  migrateRenameThreadStartersTableDown,
} from "./migrations/174-rename-thread-starters-table.js";
import { createLifecycleEventsTable } from "./migrations/175-create-lifecycle-events.js";
import {
  migrateDropCapabilityCardState,
  migrateDropCapabilityCardStateDown,
} from "./migrations/176-drop-capability-card-state.js";
import { migrateCreateTraceEventsTable } from "./migrations/177-create-trace-events-table.js";
import { migrateOAuthProvidersManagedServiceConfigKey } from "./migrations/178-oauth-providers-managed-service-config-key.js";
import { migrateLlmRequestLogMessageId } from "./migrations/179-llm-request-log-message-id.js";
import {
  migrateBackfillInlineAttachmentsToDisk,
  migrateBackfillInlineAttachmentsToDiskDown,
} from "./migrations/180-backfill-inline-attachments-to-disk.js";
import {
  migrateRenameThreadStartersCheckpoints,
  migrateRenameThreadStartersCheckpointsDown,
} from "./migrations/181-rename-thread-starters-checkpoints.js";
import { migrateOAuthProvidersDisplayMetadata } from "./migrations/182-oauth-providers-display-metadata.js";
import { migrateConversationForkLineage } from "./migrations/183-add-conversation-fork-lineage.js";
import { migrateLlmRequestLogProvider } from "./migrations/184-llm-request-log-provider.js";
import { migrateScheduleQuietFlag } from "./migrations/188-schedule-quiet-flag.js";
import { migrateDropSimplifiedMemory } from "./migrations/189-drop-simplified-memory.js";
import { migrateCallSessionSkipDisclosure } from "./migrations/190-call-session-skip-disclosure.js";
import {
  migrateBackfillAudioAttachmentMimeTypes,
  migrateBackfillAudioAttachmentMimeTypesDown,
} from "./migrations/191-backfill-audio-attachment-mime-types.js";
import { migrateContactsUserFileColumn } from "./migrations/192-contacts-user-file-column.js";
import {
  migrateAddSourceTypeColumns,
  migrateAddSourceTypeColumnsDown,
} from "./migrations/193-add-source-type-columns.js";
import { migrateCreateMemoryRecallLogs } from "./migrations/194-memory-recall-logs.js";
import { migrateOAuthProvidersPingConfig } from "./migrations/195-oauth-providers-ping-config.js";
import { migrateMessagesConversationCreatedAtIndex } from "./migrations/196-messages-conversation-created-at-index.js";
import {
  migrateStripIntegrationPrefixFromProviderKeys,
  migrateStripIntegrationPrefixFromProviderKeysDown,
} from "./migrations/196-strip-integration-prefix-from-provider-keys.js";
import { migrateOAuthProvidersBehaviorColumns } from "./migrations/197-oauth-providers-behavior-columns.js";
import { migrateDropSetupSkillIdColumn } from "./migrations/198-drop-setup-skill-id-column.js";
import { migrateGuardianRequestEnrichmentColumns } from "./migrations/199-guardian-request-enrichment-columns.js";
import { migrateUsageLlmCallCount } from "./migrations/200-usage-llm-call-count.js";
import { migrateOAuthProvidersFeatureFlag } from "./migrations/201-oauth-providers-feature-flag.js";
import { migrateDropCallbackTransportColumn } from "./migrations/202-drop-callback-transport-column.js";
import { migrateCreateMemoryGraphTables } from "./migrations/202-memory-graph-tables.js";
import { migrateDropMemoryItemsTables } from "./migrations/203-drop-memory-items-tables.js";
import {
  migrateRenameMemoryGraphTypeValues,
  migrateRenameMemoryGraphTypeValuesDown,
} from "./migrations/204-rename-memory-graph-type-values.js";
import { migrateMemoryGraphImageRefs } from "./migrations/205-memory-graph-image-refs.js";
import { migrateCreateMemoryGraphNodeEdits } from "./migrations/206-memory-graph-node-edits.js";
import {
  migrateScrubCorruptedImageAttachments,
  migrateScrubCorruptedImageAttachmentsDown,
} from "./migrations/206-scrub-corrupted-image-attachments.js";
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
import {
  downConversationHostAccess,
  migrateConversationHostAccess,
} from "./migrations/217-conversation-host-access.js";
import { migrateOAuthProvidersLogoUrl } from "./migrations/218-oauth-providers-logo-url.js";
import { migrateOAuthProvidersTokenExchangeBodyFormat } from "./migrations/219-oauth-providers-token-exchange-body-format.js";
import {
  downNormalizeUserFileByPrincipal,
  migrateNormalizeUserFileByPrincipal,
} from "./migrations/220-normalize-user-file-by-principal.js";
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
import {
  downActivationState,
  migrateActivationState,
} from "./migrations/232-activation-state.js";
import { migrateCreateDocumentConversations } from "./migrations/233-document-conversations.js";
import {
  downMemoryV2ActivationLogs,
  migrateMemoryV2ActivationLogs,
} from "./migrations/234-memory-v2-activation-logs.js";
import { migrateLlmUsageAttribution } from "./migrations/235-llm-usage-attribution.js";
import {
  downSlackCompactionWatermark,
  migrateSlackCompactionWatermark,
} from "./migrations/235-slack-compaction-watermark.js";
import {
  downToolInvocationsMatchedRuleId,
  migrateToolInvocationsMatchedRuleId,
} from "./migrations/236-tool-invocations-matched-rule-id.js";
import {
  downHeartbeatRuns,
  migrateHeartbeatRuns,
} from "./migrations/237-heartbeat-runs.js";
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
import {
  downNormalizeSlackExternalContent,
  migrateNormalizeSlackExternalContent,
} from "./migrations/249-normalize-slack-external-content.js";
import { migrateProviderConnectionBaseUrlAndModels } from "./migrations/250-provider-connection-base-url-and-models.js";
import { downA2ATasks, migrateA2ATasks } from "./migrations/251-a2a-tasks.js";
import { migrateLlmRequestLogAgentLoopExitReason } from "./migrations/252-llm-request-log-agent-loop-exit-reason.js";
import { migrateConversationLastNotifiedProfile } from "./migrations/253-conversation-last-notified-profile.js";
import { migrateCreateDocumentComments } from "./migrations/253-document-comments.js";
import {
  downExternalConversationBindingChatName,
  migrateExternalConversationBindingChatName,
} from "./migrations/254-external-conversation-binding-chat-name.js";
import { migrateChannelInboundDeliveryAttempts } from "./migrations/255-channel-inbound-delivery-attempts.js";
import {
  downMemoryV2InjectionEvents,
  migrateMemoryV2InjectionEvents,
} from "./migrations/256-memory-v2-injection-events.js";
import { migrateStripBaseUrlNonOpenaiCompatible } from "./migrations/257-strip-base-url-non-openai-compatible.js";
import { migrateOnboardingEventsPriorAssistants } from "./migrations/258-onboarding-events-prior-assistants.js";
import {
  downConversationCleanedAt,
  migrateConversationCleanedAt,
} from "./migrations/259-conversation-cleaned-at.js";
import {
  downRenameCleanedAt,
  migrateRenameCleanedAt,
} from "./migrations/260-rename-cleaned-at.js";
import {
  downLlmUsageAddRawUsage,
  migrateLlmUsageAddRawUsage,
} from "./migrations/261-llm-usage-add-raw-usage.js";
import {
  downMemoryV3Coactivation,
  migrateMemoryV3Coactivation,
} from "./migrations/262-memory-v3-coactivation.js";
import {
  downMemoryV3AutoEdges,
  migrateMemoryV3AutoEdges,
} from "./migrations/263-memory-v3-auto-edges.js";
import { migrateLlmRequestLogCallSite } from "./migrations/264-llm-request-log-call-site.js";
import { migrateDropProviderConnectionStatus } from "./migrations/265-drop-provider-connection-status.js";
import { migrateMessagesClientMessageId } from "./migrations/266-messages-client-message-id.js";
import { migrateLlmUsageEventsAddAssistantVersion } from "./migrations/267-llm-usage-events-add-assistant-version.js";
import { migrateAddMemoryV3Selections } from "./migrations/268-add-memory-v3-selections.js";
import { migrateScheduleScriptTimeout } from "./migrations/269-schedule-script-timeout.js";
import { migrateMessagesRoleCreatedAtIndex } from "./migrations/270-messages-role-created-at-index.js";
import {
  downScheduleDescription,
  migrateScheduleDescription,
} from "./migrations/270-schedule-description.js";
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
import { migrateCanonicalGuardianDeliveriesConversationIndex } from "./migrations/299-canonical-guardian-deliveries-conversation-index.js";
import { migrateAddProcessingStartedAt } from "./migrations/300-add-processing-started-at.js";
import { createWatchdogEventsTable } from "./migrations/301-create-watchdog-events.js";
import { migrateCreateCompactionEvents } from "./migrations/302-create-compaction-events.js";
import { migrateAddConversationCreationSeq } from "./migrations/303-add-conversation-creation-seq.js";
import { migrateAddLlmUsageCronRunId } from "./migrations/304-add-llm-usage-cron-run-id.js";
import { migrateDropContactAclColumns } from "./migrations/305-drop-contact-acl-columns.js";
import { migrateRewriteFrontierProfilePins } from "./migrations/306-rewrite-frontier-profile-pins.js";
import { migrateAcpSessionHistoryUsageColumns } from "./migrations/307-acp-session-history-usage-columns.js";
import { migrateAcpSessionHistoryTokenColumns } from "./migrations/308-acp-session-history-token-columns.js";
import { migrateDropRedundantIndexes } from "./migrations/309-drop-redundant-indexes.js";
import { migrateLlmRequestLogLatencyBreakdown } from "./migrations/310-llm-request-log-latency-breakdown.js";
import { migrateCreateSubagentsTable } from "./migrations/311-create-subagents-table.js";
import { migrateDropInboxConversationStateTable } from "./migrations/312-drop-inbox-conversation-state-table.js";
import { migrateDropMessagesFts } from "./migrations/313-drop-messages-fts.js";
import { migrateAddConversationEnabledPlugins } from "./migrations/314-add-conversation-enabled-plugins.js";
import { migrateCreateA2aInvitesTable } from "./migrations/315-create-a2a-invites.js";
import { migrateDropContactChannelInviteId } from "./migrations/316-drop-contact-channels-invite-id.js";
import { migrateCanonicalGuardianRequesterSignals } from "./migrations/317-canonical-guardian-requester-signals.js";
import { migrateDropContactChannelTelemetry } from "./migrations/318-drop-contact-channel-telemetry.js";
import { migrateRemoveLegacyManagedConnections } from "./migrations/319-remove-legacy-managed-connections.js";
import { migrateDropTraceEventsTable } from "./migrations/320-drop-trace-events-table.js";
import { migrateCanonicalGuardianRequestTrigger } from "./migrations/321-canonical-guardian-request-trigger.js";
import { migrateAddProcessingResumeAttempts } from "./migrations/322-add-processing-resume-attempts.js";
import { migrateDeleteNonDefaultMemoryScopes } from "./migrations/323-delete-non-default-memory-scopes.js";
import { migrateMessageFinalizedColumn } from "./migrations/324-message-finalized-column.js";
import { createConfigSettingEventsTable } from "./migrations/325-create-config-setting-events.js";
import { migrateMoveInjectionEventsToMemoryDb } from "./migrations/326-move-injection-events-to-memory-db.js";
import type { MigrationStep } from "./migrations/run-migrations.js";

export const migrationSteps: MigrationStep[] = [
  migrateCoreTables,
  createWatchersAndLogsTables,
  addCoreColumns,
  {
    name: "migrateJobDeferrals",
    run: migrateJobDeferrals,
    rollback: [
      {
        version: 1,
        description:
          "Reconcile legacy deferral history from attempts column into deferrals column",
        down: downJobDeferrals,
      },
    ],
  },
  migrateToolInvocationsFk,
  {
    name: "migrateMemoryEntityRelationDedup",
    run: migrateMemoryEntityRelationDedup,
    rollback: [
      {
        version: 2,
        description:
          "Deduplicate entity relation edges before enforcing the (source, target, relation) unique index",
        down: downMemoryEntityRelationDedup,
      },
    ],
  },
  {
    name: "migrateMemoryItemsFingerprintScopeUnique",
    run: migrateMemoryItemsFingerprintScopeUnique,
    rollback: [
      {
        version: 3,
        description:
          "Replace column-level UNIQUE on fingerprint with compound (fingerprint, scope_id) unique index",
        down: downMemoryItemsFingerprintScopeUnique,
      },
    ],
  },
  {
    name: "migrateMemoryItemsScopeSaltedFingerprints",
    run: migrateMemoryItemsScopeSaltedFingerprints,
    dependsOn: ["migrateMemoryItemsFingerprintScopeUnique"],
    rollback: [
      {
        version: 4,
        description:
          "Recompute memory item fingerprints to include scope_id prefix after schema change",
        down: downMemoryItemsScopeSaltedFingerprints,
      },
    ],
  },
  {
    name: "migrateAssistantIdToSelf",
    run: migrateAssistantIdToSelf,
    rollback: [
      {
        version: 5,
        description:
          "Normalize all assistant_id values in scoped tables to the implicit single-tenant identity",
        down: downAssistantIdToSelf,
      },
    ],
  },
  {
    name: "migrateRemoveAssistantIdColumns",
    run: migrateRemoveAssistantIdColumns,
    dependsOn: ["migrateAssistantIdToSelf"],
    rollback: [
      {
        version: 6,
        description:
          "Rebuild four tables to drop the assistant_id column after normalization",
        down: downRemoveAssistantIdColumns,
      },
    ],
  },
  {
    name: "migrateLlmUsageEventsDropAssistantId",
    run: migrateLlmUsageEventsDropAssistantId,
    dependsOn: ["migrateAssistantIdToSelf"],
    rollback: [
      {
        version: 7,
        description:
          "Remove assistant_id column from llm_usage_events (separate checkpoint from the four-table migration)",
        down: downLlmUsageEventsDropAssistantId,
      },
    ],
  },
  {
    name: "createCoreIndexes",
    run: createCoreIndexes,
    rollback: [
      {
        version: 9,
        description:
          "Drop old idx_memory_items_active_search so it can be recreated with updated covering columns",
        down: downDropActiveSearchIndex,
      },
    ],
  },
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
  {
    name: "createAssistantInboxTables",
    run: createAssistantInboxTables,
    rollback: [
      {
        version: 8,
        description:
          "Seed assistant_inbox_thread_state from external_conversation_bindings",
        down: downBackfillInboxThreadState,
      },
    ],
  },
  migrateGuardianActionTables,
  migrateMemoryFtsBackfill,
  migrateMemorySegmentsIndexes,
  migrateMemoryItemsIndexes,
  migrateRemainingTableIndexes,
  {
    name: "migrateRenameChannelToVellum",
    run: migrateRenameChannelToVellum,
    rollback: [
      {
        version: 11,
        description:
          "Rename macos and ios channel identifiers to vellum across all tables",
        down: downRenameChannelToVellum,
      },
    ],
  },
  migrateConversationStatusIndexes,
  migrateAddOriginInterface,
  migrateMemoryItemSourcesIndexes,
  {
    name: "migrateEmbeddingVectorBlob",
    run: migrateEmbeddingVectorBlob,
    rollback: [
      {
        version: 12,
        description:
          "Add vector_blob BLOB column to memory_embeddings and backfill from vector_json for compact binary storage",
        down: downEmbeddingVectorBlob,
      },
    ],
  },
  {
    name: "migrateEmbeddingsNullableVectorJson",
    run: migrateEmbeddingsNullableVectorJson,
    dependsOn: ["migrateEmbeddingVectorBlob"],
    rollback: [
      {
        version: 13,
        description:
          "Rebuild memory_embeddings to make vector_json nullable (pre-100 DBs had NOT NULL)",
        down: downEmbeddingsNullableVectorJson,
      },
    ],
  },
  migrateChannelInboundDeliveredSegments,
  migrateGuardianActionFollowup,
  migrateGuardianActionToolMetadata,
  migrateGuardianActionSupersession,
  migrateConversationsThreadTypeIndex,
  migrateGuardianDeliveryConversationIndex,
  {
    name: "createNotificationTables",
    run: createNotificationTables,
    rollback: [
      {
        version: 10,
        description:
          "Drop legacy enum-based notification tables so they can be recreated with the new signal-contract schema",
        down: downNotificationTablesSchema,
      },
    ],
  },
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
  {
    name: "migrateNormalizePhoneIdentities",
    run: migrateNormalizePhoneIdentities,
    rollback: [
      {
        version: 14,
        description:
          "Normalize phone-like identity fields to E.164 format across guardian bindings, verification challenges, canonical requests, ingress members, and rate limits",
        down: downNormalizePhoneIdentities,
      },
    ],
  },
  migrateVoiceInviteColumns,
  migrateVoiceInviteDisplayMetadata,
  migrateInviteCodeHashColumn,
  createApprovalPromptTsTrackerTable,
  migrateGuardianPrincipalIdColumns,
  {
    name: "migrateBackfillGuardianPrincipalId",
    run: migrateBackfillGuardianPrincipalId,
    rollback: [
      {
        version: 15,
        description:
          "Backfill guardianPrincipalId for existing channel_guardian_bindings and canonical_guardian_requests rows, expire unresolvable pending requests",
        down: downBackfillGuardianPrincipalId,
      },
    ],
  },
  {
    name: "migrateGuardianPrincipalIdNotNull",
    run: migrateGuardianPrincipalIdNotNull,
    dependsOn: ["migrateBackfillGuardianPrincipalId"],
    rollback: [
      {
        version: 16,
        description:
          "Enforce NOT NULL on channel_guardian_bindings.guardian_principal_id after backfill",
        down: downGuardianPrincipalIdNotNull,
      },
    ],
  },
  migrateContactsRolePrincipal,
  migrateContactChannelsAccessFields,
  migrateContactChannelsTypeChatIdIndex,
  migrateDropLegacyMemberGuardianTables,
  migrateContactsAssistantId,
  migrateAssistantContactMetadata,
  {
    name: "migrateContactsNotesColumn",
    run: migrateContactsNotesColumn,
    rollback: [
      {
        version: 17,
        description:
          "Consolidate relationship/importance/response_expectation/preferred_tone into a single notes TEXT column, then drop the legacy columns",
        down: downContactsNotesColumn,
      },
    ],
  },
  {
    name: "migrateBackfillContactInteractionStats",
    run: migrateBackfillContactInteractionStats,
    rollback: [
      {
        version: 18,
        description:
          "Backfill contacts.last_interaction from the max lastSeenAt across each contact's channels",
        down: downBackfillContactInteractionStats,
      },
    ],
  },
  {
    name: "migrateDropAssistantIdColumns",
    run: migrateDropAssistantIdColumns,
    dependsOn: ["migrateAssistantIdToSelf"],
    rollback: [
      {
        version: 19,
        description:
          "Drop assistant_id columns from all 16 daemon tables after normalization to single-tenant identity",
        down: downDropAssistantIdColumns,
      },
    ],
  },
  migrateUsageDashboardIndexes,
  migrateDropUsageCompositeIndexes,
  {
    name: "migrateBackfillUsageCacheAccounting",
    run: migrateBackfillUsageCacheAccounting,
    rollback: [
      {
        version: 20,
        description:
          "Backfill historical Anthropic llm_usage_events rows from llm_request_logs with cache-aware pricing",
        down: downBackfillUsageCacheAccounting,
      },
    ],
  },
  {
    name: "migrateRenameVerificationTable",
    run: migrateRenameVerificationTable,
    rollback: [
      {
        version: 21,
        description:
          "Rename channel_guardian_verification_challenges table to channel_verification_sessions and update indexes",
        down: downRenameVerificationTable,
      },
    ],
  },
  {
    name: "migrateRenameVerificationSessionIdColumn",
    run: migrateRenameVerificationSessionIdColumn,
    rollback: [
      {
        version: 22,
        description:
          "Rename guardian_verification_session_id column in call_sessions to verification_session_id",
        down: downRenameVerificationSessionIdColumn,
      },
    ],
  },
  {
    name: "migrateRenameGuardianVerificationValues",
    run: migrateRenameGuardianVerificationValues,
    rollback: [
      {
        version: 23,
        description:
          "Rename persisted guardian_verification call_mode and guardian_voice_verification_* event_type values to drop the guardian_ prefix",
        down: downRenameGuardianVerificationValues,
      },
    ],
  },
  {
    name: "migrateRenameVoiceToPhone",
    run: migrateRenameVoiceToPhone,
    rollback: [
      {
        version: 24,
        description:
          'Rename stored "voice" channel values to "phone" across all tables with channel text columns',
        down: downRenameVoiceToPhone,
      },
    ],
  },
  {
    name: "migrateDropAccountsTable",
    run: migrateDropAccountsTable,
    rollback: [
      {
        version: 25,
        description:
          "Drop the unused legacy accounts table and its leftover indexes after account_manage removal",
        down: migrateDropAccountsTableDown,
      },
    ],
  },
  migrateScheduleOneShotRouting,
  {
    name: "migrateRemindersToSchedules",
    run: migrateRemindersToSchedules,
    rollback: [
      {
        version: 26,
        description:
          "Copy all existing reminders into cron_jobs as one-shot schedules with correct status and field mapping",
        down: migrateRemindersToSchedulesDown,
      },
    ],
  },
  {
    name: "migrateDropRemindersTable",
    run: migrateDropRemindersTable,
    dependsOn: ["migrateRemindersToSchedules"],
    rollback: [
      {
        version: 27,
        description:
          "Drop the legacy reminders table and its index after data migration to cron_jobs",
        down: migrateDropRemindersTableDown,
      },
    ],
  },
  createOAuthTables,
  {
    name: "migrateOAuthAppsClientSecretPath",
    run: migrateOAuthAppsClientSecretPath,
    rollback: [
      {
        version: 28,
        description:
          "Add client_secret_credential_path column to oauth_apps and backfill existing rows with convention-based paths",
        down: migrateOAuthAppsClientSecretPathDown,
      },
    ],
  },
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
  {
    name: "migrateGuardianTimestampsEpochMs",
    run: migrateGuardianTimestampsEpochMs,
    rollback: [
      {
        version: 29,
        description:
          "Convert guardian table timestamps from ISO 8601 text to epoch ms integers for consistency with all other tables",
        down: migrateGuardianTimestampsEpochMsDown,
      },
      {
        version: 30,
        description:
          "Rebuild guardian tables so timestamp columns have INTEGER affinity instead of TEXT",
        down: migrateGuardianTimestampsRebuildDown,
      },
    ],
  },
  migrateRenameInboxThreadStateTable,
  migrateRenameConversationTypeColumn,
  migrateRenameNotificationThreadColumns,
  migrateRenameFollowupsThreadIdColumn,
  migrateRenameSequenceEnrollmentsThreadIdColumn,
  migrateRenameSequenceStepsReplyKey,
  {
    name: "migrateRenameGmailProviderKeyToGoogle",
    run: migrateRenameGmailProviderKeyToGoogle,
    rollback: [
      {
        version: 31,
        description:
          "Rename integration:gmail provider key to integration:google across oauth_providers, oauth_apps, and oauth_connections",
        down: migrateRenameGmailProviderKeyToGoogleDown,
      },
    ],
  },
  migrateCreateThreadStartersTable,
  migrateCapabilityCardColumns,
  migrateRenameCreatedBySessionIdColumns,
  migrateRenameSourceSessionIdColumn,
  {
    name: "migrateRenameThreadStartersTable",
    run: migrateRenameThreadStartersTable,
    rollback: [
      {
        version: 32,
        description:
          "Rename thread_starters table to conversation_starters and recreate indexes with new names",
        down: migrateRenameThreadStartersTableDown,
      },
    ],
  },
  {
    name: "migrateRenameThreadStartersCheckpoints",
    run: migrateRenameThreadStartersCheckpoints,
    dependsOn: ["migrateRenameThreadStartersTable"],
    rollback: [
      {
        version: 35,
        description:
          "Rename checkpoint keys from thread_starters: to conversation_starters: prefix so renamed code paths find existing generation state",
        down: migrateRenameThreadStartersCheckpointsDown,
      },
    ],
  },
  createLifecycleEventsTable,
  {
    name: "migrateDropCapabilityCardState",
    run: migrateDropCapabilityCardState,
    dependsOn: ["migrateRenameThreadStartersTable"],
    rollback: [
      {
        version: 33,
        description:
          "Remove deleted capability-card rows, jobs, checkpoints, and category state",
        down: migrateDropCapabilityCardStateDown,
      },
    ],
  },
  migrateCreateTraceEventsTable,
  migrateOAuthProvidersManagedServiceConfigKey,
  migrateOAuthProvidersDisplayMetadata,
  migrateLlmRequestLogMessageId,
  migrateLlmRequestLogProvider,
  {
    name: "migrateBackfillInlineAttachmentsToDisk",
    run: migrateBackfillInlineAttachmentsToDisk,
    rollback: [
      {
        version: 34,
        description:
          "Backfill existing inline base64 attachments to on-disk storage and clear dataBase64",
        down: migrateBackfillInlineAttachmentsToDiskDown,
      },
    ],
  },
  migrateConversationForkLineage,
  migrateScheduleQuietFlag,
  migrateDropSimplifiedMemory,
  migrateCallSessionSkipDisclosure,
  {
    name: "migrateBackfillAudioAttachmentMimeTypes",
    run: migrateBackfillAudioAttachmentMimeTypes,
    rollback: [
      {
        version: 36,
        description:
          "Backfill correct MIME types for audio attachments stored as application/octet-stream due to missing extension map entries",
        down: migrateBackfillAudioAttachmentMimeTypesDown,
      },
    ],
  },
  migrateContactsUserFileColumn,
  {
    name: "migrateAddSourceTypeColumns",
    run: migrateAddSourceTypeColumns,
    rollback: [
      {
        version: 37,
        description:
          "Add source_type and source_message_role columns to memory_items with backfill from verification_state and source messages",
        down: migrateAddSourceTypeColumnsDown,
      },
    ],
  },
  migrateCreateMemoryRecallLogs,
  migrateOAuthProvidersPingConfig,
  {
    name: "migrateStripIntegrationPrefixFromProviderKeys",
    run: migrateStripIntegrationPrefixFromProviderKeys,
    rollback: [
      {
        version: 38,
        description:
          "Strip integration: prefix from provider_key across oauth_providers, oauth_apps, and oauth_connections",
        down: migrateStripIntegrationPrefixFromProviderKeysDown,
      },
    ],
  },
  migrateMessagesConversationCreatedAtIndex,
  migrateOAuthProvidersBehaviorColumns,
  migrateDropSetupSkillIdColumn,
  migrateGuardianRequestEnrichmentColumns,
  migrateUsageLlmCallCount,
  migrateOAuthProvidersFeatureFlag,
  migrateDropCallbackTransportColumn,
  migrateCreateMemoryGraphTables,
  migrateMemoryGraphImageRefs,
  // 101b. Migrate tool-created items from legacy memory_items → graph nodes.
  // Must run before migrateDropMemoryItemsTables so data is preserved.
  migrateToolCreatedItems,
  migrateDropMemoryItemsTables,
  {
    name: "migrateRenameMemoryGraphTypeValues",
    run: migrateRenameMemoryGraphTypeValues,
    rollback: [
      {
        version: 39,
        description:
          "Rename legacy memory graph node type values: style → behavioral, relationship → semantic",
        down: migrateRenameMemoryGraphTypeValuesDown,
      },
    ],
  },
  migrateCreateMemoryGraphNodeEdits,
  {
    name: "migrateScrubCorruptedImageAttachments",
    run: migrateScrubCorruptedImageAttachments,
    rollback: [
      {
        version: 40,
        description:
          "Remove image attachments containing HTML error pages instead of image data",
        down: migrateScrubCorruptedImageAttachmentsDown,
      },
    ],
  },
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
  {
    name: "migrateConversationHostAccess",
    run: migrateConversationHostAccess,
    rollback: [
      {
        version: 41,
        description:
          "Add a host_access column to conversations so computer access is persisted per conversation with a safe default of disabled",
        down: downConversationHostAccess,
      },
    ],
  },
  migrateOAuthProvidersLogoUrl,
  migrateOAuthProvidersTokenExchangeBodyFormat,
  {
    name: "migrateNormalizeUserFileByPrincipal",
    run: migrateNormalizeUserFileByPrincipal,
    rollback: [
      {
        version: 42,
        description:
          "Normalize contacts.user_file across rows sharing the same principal_id so every channel for one principal loads the same users/<slug>.md persona and journal directory",
        down: downNormalizeUserFileByPrincipal,
      },
    ],
  },
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
  {
    name: "migrateActivationState",
    run: migrateActivationState,
    rollback: [
      {
        version: 43,
        description: "Create activation_state table for memory v2",
        down: downActivationState,
      },
    ],
  },
  migrateActivationStateFkCascade,
  {
    name: "migrateMemoryV2ActivationLogs",
    run: migrateMemoryV2ActivationLogs,
    rollback: [
      {
        version: 44,
        description:
          "Create memory_v2_activation_logs table for per-turn v2 activation telemetry consumed by the LLM Context Inspector",
        down: downMemoryV2ActivationLogs,
      },
    ],
  },
  migrateCreateDocumentConversations,
  migrateLlmUsageAttribution,
  {
    name: "migrateSlackCompactionWatermark",
    run: migrateSlackCompactionWatermark,
    rollback: [
      {
        version: 45,
        description:
          "Add Slack-specific compaction watermark columns to conversations",
        down: downSlackCompactionWatermark,
      },
    ],
  },
  {
    name: "migrateToolInvocationsMatchedRuleId",
    run: migrateToolInvocationsMatchedRuleId,
    rollback: [
      {
        version: 46,
        description:
          "Add matched_trust_rule_id column to tool_invocations for trust rule audit and rule editor UI",
        down: downToolInvocationsMatchedRuleId,
      },
    ],
  },
  {
    name: "migrateHeartbeatRuns",
    run: migrateHeartbeatRuns,
    rollback: [
      {
        version: 47,
        description:
          "Create heartbeat_runs table for tracking heartbeat execution lifecycle with CAS state transitions",
        down: downHeartbeatRuns,
      },
    ],
  },
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
  {
    name: "migrateNormalizeSlackExternalContent",
    run: migrateNormalizeSlackExternalContent,
    rollback: [
      {
        version: 48,
        description:
          "Normalize legacy persisted Slack external_content wrappers back to raw message content",
        down: downNormalizeSlackExternalContent,
      },
    ],
  },
  migrateProviderConnectionBaseUrlAndModels,
  {
    name: "migrateA2ATasks",
    run: migrateA2ATasks,
    rollback: [
      {
        version: 49,
        description:
          "Create a2a_tasks table for tracking A2A request/response lifecycle",
        down: downA2ATasks,
      },
    ],
  },
  migrateLlmRequestLogAgentLoopExitReason,
  migrateCreateDocumentComments,
  {
    name: "migrateExternalConversationBindingChatName",
    run: migrateExternalConversationBindingChatName,
    rollback: [
      {
        version: 50,
        description:
          "Add external_chat_name to external conversation bindings for channel footer metadata",
        down: downExternalConversationBindingChatName,
      },
    ],
  },
  migrateChannelInboundDeliveryAttempts,
  {
    name: "migrateMemoryV2InjectionEvents",
    run: migrateMemoryV2InjectionEvents,
    dependsOn: ["migrateMemoryV2ActivationLogs"],
    rollback: [
      {
        version: 51,
        description:
          "Create memory_v2_injection_events table and backfill from activation logs for EMA-based tier 2 routing",
        down: downMemoryV2InjectionEvents,
      },
    ],
  },
  migrateConversationLastNotifiedProfile,
  migrateStripBaseUrlNonOpenaiCompatible,
  migrateOnboardingEventsPriorAssistants,
  {
    name: "migrateConversationCleanedAt",
    run: migrateConversationCleanedAt,
    rollback: [
      {
        version: 52,
        description:
          "Add cleaned_at timestamp to conversations so /clean survives reload and forks inherit conditionally on fork point",
        down: downConversationCleanedAt,
      },
    ],
  },
  {
    name: "migrateRenameCleanedAt",
    run: migrateRenameCleanedAt,
    dependsOn: ["migrateConversationCleanedAt"],
    rollback: [
      {
        version: 53,
        description:
          "Rename conversations.cleaned_at to history_stripped_at; the marker now records any injection-strip event (including compaction), not just /clean",
        down: downRenameCleanedAt,
      },
    ],
  },
  {
    name: "migrateLlmUsageAddRawUsage",
    run: migrateLlmUsageAddRawUsage,
    rollback: [
      {
        version: 54,
        description:
          "Add raw_usage TEXT column to llm_usage_events for storing the provider's untouched usage block as JSON (Anthropic TTL breakdown, OpenAI prompt/completion token details, etc.) so downstream consumers can extract provider-specific detail without per-field schema changes",
        down: downLlmUsageAddRawUsage,
      },
    ],
  },
  {
    name: "migrateMemoryV3Coactivation",
    run: migrateMemoryV3Coactivation,
    rollback: [
      {
        version: 55,
        description:
          "Create memory_v3_coactivation table — append-only log of pass-1 → pass-N co-activation pairs (gradient signal) emitted by the v3 retrieval loop and reconciled later by edge-learning",
        down: downMemoryV3Coactivation,
      },
    ],
  },
  {
    name: "migrateMemoryV3AutoEdges",
    run: migrateMemoryV3AutoEdges,
    rollback: [
      {
        version: 56,
        description:
          "Create memory_v3_auto_edges table — weighted, decaying learned association graph (distinct from curated edges:) accrued by the edge-learning job from used co-activations and consumed above-threshold by edge expansion",
        down: downMemoryV3AutoEdges,
      },
    ],
  },
  migrateLlmRequestLogCallSite,
  migrateDropProviderConnectionStatus,
  migrateMessagesClientMessageId,
  migrateLlmUsageEventsAddAssistantVersion,
  migrateAddMemoryV3Selections,
  migrateScheduleScriptTimeout,
  {
    name: "migrateScheduleDescription",
    run: migrateScheduleDescription,
    rollback: [
      {
        version: 57,
        description:
          "Backfill authored schedule descriptions for legacy non-defer schedules from their existing names",
        down: downScheduleDescription,
      },
    ],
  },
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
  migrateCanonicalGuardianDeliveriesConversationIndex,
  migrateAddProcessingStartedAt,
  createWatchdogEventsTable,
  migrateCreateCompactionEvents,
  migrateAddConversationCreationSeq,
  migrateAddLlmUsageCronRunId,
  migrateDropContactAclColumns,
  migrateRewriteFrontierProfilePins,
  migrateAcpSessionHistoryUsageColumns,
  migrateAcpSessionHistoryTokenColumns,
  migrateDropRedundantIndexes,
  migrateLlmRequestLogLatencyBreakdown,
  migrateCreateSubagentsTable,
  migrateDropInboxConversationStateTable,
  migrateDropMessagesFts,
  migrateAddConversationEnabledPlugins,
  migrateCreateA2aInvitesTable,
  migrateDropContactChannelInviteId,
  migrateCanonicalGuardianRequesterSignals,
  migrateDropContactChannelTelemetry,
  migrateRemoveLegacyManagedConnections,
  migrateDropTraceEventsTable,
  migrateCanonicalGuardianRequestTrigger,
  migrateAddProcessingResumeAttempts,
  migrateDeleteNonDefaultMemoryScopes,
  migrateMessageFinalizedColumn,
  createConfigSettingEventsTable,
  migrateMoveInjectionEventsToMemoryDb,
];

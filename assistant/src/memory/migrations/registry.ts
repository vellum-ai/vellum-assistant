import type { DrizzleDb } from "../db-connection.js";
import { downJobDeferrals } from "./001-job-deferrals.js";
import { downMemoryEntityRelationDedup } from "./004-entity-relation-dedup.js";
import { downMemoryItemsFingerprintScopeUnique } from "./005-fingerprint-scope-unique.js";
import { downMemoryItemsScopeSaltedFingerprints } from "./006-scope-salted-fingerprints.js";
import { downAssistantIdToSelf } from "./007-assistant-id-to-self.js";
import { downRemoveAssistantIdColumns } from "./008-remove-assistant-id-columns.js";
import { downLlmUsageEventsDropAssistantId } from "./009-llm-usage-events-drop-assistant-id.js";
import { downBackfillInboxThreadState } from "./014-backfill-inbox-thread-state.js";
import { downDropActiveSearchIndex } from "./015-drop-active-search-index.js";
import { downNotificationTablesSchema } from "./019-notification-tables-schema-migration.js";
import { downRenameChannelToVellum } from "./020-rename-macos-ios-channel-to-vellum.js";
import { downEmbeddingVectorBlob } from "./024-embedding-vector-blob.js";
import { downEmbeddingsNullableVectorJson } from "./026a-embeddings-nullable-vector-json.js";
import { downNormalizePhoneIdentities } from "./036-normalize-phone-identities.js";
import { downBackfillGuardianPrincipalId } from "./126-backfill-guardian-principal-id.js";
import { downGuardianPrincipalIdNotNull } from "./127-guardian-principal-id-not-null.js";
import { downContactsNotesColumn } from "./134-contacts-notes-column.js";
import { downBackfillContactInteractionStats } from "./135-backfill-contact-interaction-stats.js";
import { downDropAssistantIdColumns } from "./136-drop-assistant-id-columns.js";
import { downBackfillUsageCacheAccounting } from "./140-backfill-usage-cache-accounting.js";
import { downRenameVerificationTable } from "./141-rename-verification-table.js";
import { downRenameVerificationSessionIdColumn } from "./142-rename-verification-session-id-column.js";
import { downRenameGuardianVerificationValues } from "./143-rename-guardian-verification-values.js";
import { downRenameVoiceToPhone } from "./144-rename-voice-to-phone.js";
import { migrateDropAccountsTableDown } from "./145-drop-accounts-table.js";
import { migrateRemindersToSchedulesDown } from "./147-migrate-reminders-to-schedules.js";
import { migrateDropRemindersTableDown } from "./148-drop-reminders-table.js";
import { migrateOAuthAppsClientSecretPathDown } from "./150-oauth-apps-client-secret-path.js";
import {
  migrateGuardianTimestampsEpochMsDown,
  migrateGuardianTimestampsRebuildDown,
} from "./162-guardian-timestamps-epoch-ms.js";
import { migrateRenameGmailProviderKeyToGoogleDown } from "./169-rename-gmail-provider-key-to-google.js";
import { migrateRenameThreadStartersTableDown } from "./174-rename-thread-starters-table.js";
import { migrateDropCapabilityCardStateDown } from "./176-drop-capability-card-state.js";
import { migrateBackfillInlineAttachmentsToDiskDown } from "./180-backfill-inline-attachments-to-disk.js";
import { migrateRenameThreadStartersCheckpointsDown } from "./181-rename-thread-starters-checkpoints.js";
import { migrateBackfillAudioAttachmentMimeTypesDown } from "./191-backfill-audio-attachment-mime-types.js";
import { migrateAddSourceTypeColumnsDown } from "./193-add-source-type-columns.js";
import { migrateStripIntegrationPrefixFromProviderKeysDown } from "./196-strip-integration-prefix-from-provider-keys.js";
import { migrateRenameMemoryGraphTypeValuesDown } from "./204-rename-memory-graph-type-values.js";
import { migrateScrubCorruptedImageAttachmentsDown } from "./206-scrub-corrupted-image-attachments.js";
import { downConversationHostAccess } from "./217-conversation-host-access.js";
import { downNormalizeUserFileByPrincipal } from "./220-normalize-user-file-by-principal.js";
import { downActivationState } from "./232-activation-state.js";
import { downMemoryV2ActivationLogs } from "./234-memory-v2-activation-logs.js";
import { downSlackCompactionWatermark } from "./235-slack-compaction-watermark.js";
import { downToolInvocationsMatchedRuleId } from "./236-tool-invocations-matched-rule-id.js";

export interface MigrationRegistryEntry {
  /** The checkpoint key written to memory_checkpoints on completion. */
  key: string;
  /** Monotonic version number used for ordering assertions. */
  version: number;
  /** Keys of other migrations that must complete before this one runs. */
  dependsOn?: string[];
  /** Human-readable description for diagnostics and future authorship guidance. */
  description: string;
  /** Reverse the migration. Must be idempotent — safe to re-run. */
  down: (database: DrizzleDb) => void;
}

// ---------------------------------------------------------------------------
// Central registry of all checkpoint-based one-shot migrations.  Each entry
// carries a monotonic version number (for documentation / ordering assertions)
// and an optional list of prerequisite checkpoint keys that must already be
// completed before this migration runs.
//
// Migrations that use pure DDL guards (CREATE TABLE IF NOT EXISTS, index
// presence checks, ALTER TABLE ADD COLUMN try/catch) are inherently idempotent
// and do not need entries here — they are safe to re-run on every startup.
// ---------------------------------------------------------------------------

export const MIGRATION_REGISTRY: MigrationRegistryEntry[] = [
  {
    key: "migration_job_deferrals",
    version: 1,
    description:
      "Reconcile legacy deferral history from attempts column into deferrals column",
    down: downJobDeferrals,
  },
  {
    key: "migration_memory_entity_relations_dedup_v1",
    version: 2,
    description:
      "Deduplicate entity relation edges before enforcing the (source, target, relation) unique index",
    down: downMemoryEntityRelationDedup,
  },
  {
    key: "migration_memory_items_fingerprint_scope_unique_v1",
    version: 3,
    description:
      "Replace column-level UNIQUE on fingerprint with compound (fingerprint, scope_id) unique index",
    down: downMemoryItemsFingerprintScopeUnique,
  },
  {
    key: "migration_memory_items_scope_salted_fingerprints_v1",
    version: 4,
    dependsOn: ["migration_memory_items_fingerprint_scope_unique_v1"],
    description:
      "Recompute memory item fingerprints to include scope_id prefix after schema change",
    down: downMemoryItemsScopeSaltedFingerprints,
  },
  {
    key: "migration_normalize_assistant_id_to_self_v1",
    version: 5,
    description:
      'Normalize all assistant_id values in scoped tables to the implicit "self" single-tenant identity',
    down: downAssistantIdToSelf,
  },
  {
    key: "migration_remove_assistant_id_columns_v1",
    version: 6,
    dependsOn: ["migration_normalize_assistant_id_to_self_v1"],
    description:
      "Rebuild four tables to drop the assistant_id column after normalization",
    down: downRemoveAssistantIdColumns,
  },
  {
    key: "migration_remove_assistant_id_lue_v1",
    version: 7,
    dependsOn: ["migration_normalize_assistant_id_to_self_v1"],
    description:
      "Remove assistant_id column from llm_usage_events (separate checkpoint from the four-table migration)",
    down: downLlmUsageEventsDropAssistantId,
  },
  {
    key: "backfill_inbox_thread_state_from_bindings",
    version: 8,
    description:
      "Seed assistant_inbox_thread_state from external_conversation_bindings",
    down: downBackfillInboxThreadState,
  },
  {
    key: "drop_active_search_index_v1",
    version: 9,
    description:
      "Drop old idx_memory_items_active_search so it can be recreated with updated covering columns",
    down: downDropActiveSearchIndex,
  },
  {
    key: "migration_notification_tables_schema_v1",
    version: 10,
    description:
      "Drop legacy enum-based notification tables so they can be recreated with the new signal-contract schema",
    down: downNotificationTablesSchema,
  },
  {
    key: "migration_rename_macos_ios_channel_to_vellum_v1",
    version: 11,
    description:
      "Rename macos and ios channel identifiers to vellum across all tables",
    down: downRenameChannelToVellum,
  },
  {
    key: "migration_embedding_vector_blob_v1",
    version: 12,
    description:
      "Add vector_blob BLOB column to memory_embeddings and backfill from vector_json for compact binary storage",
    down: downEmbeddingVectorBlob,
  },
  {
    key: "migration_embeddings_nullable_vector_json_v1",
    version: 13,
    dependsOn: ["migration_embedding_vector_blob_v1"],
    description:
      "Rebuild memory_embeddings to make vector_json nullable (pre-100 DBs had NOT NULL)",
    down: downEmbeddingsNullableVectorJson,
  },
  {
    key: "migration_normalize_phone_identities_v1",
    version: 14,
    description:
      "Normalize phone-like identity fields to E.164 format across guardian bindings, verification challenges, canonical requests, ingress members, and rate limits",
    down: downNormalizePhoneIdentities,
  },
  {
    key: "migration_backfill_guardian_principal_id_v3",
    version: 15,
    description:
      "Backfill guardianPrincipalId for existing channel_guardian_bindings and canonical_guardian_requests rows, expire unresolvable pending requests",
    down: downBackfillGuardianPrincipalId,
  },
  {
    key: "migration_guardian_principal_id_not_null_v1",
    version: 16,
    dependsOn: ["migration_backfill_guardian_principal_id_v3"],
    description:
      "Enforce NOT NULL on channel_guardian_bindings.guardian_principal_id after backfill",
    down: downGuardianPrincipalIdNotNull,
  },
  {
    key: "migration_contacts_notes_column_v1",
    version: 17,
    description:
      "Consolidate relationship/importance/response_expectation/preferred_tone into a single notes TEXT column, then drop the legacy columns",
    down: downContactsNotesColumn,
  },
  {
    key: "backfill_contact_interaction_stats",
    version: 18,
    description:
      "Backfill contacts.last_interaction from the max lastSeenAt across each contact's channels",
    down: downBackfillContactInteractionStats,
  },
  {
    key: "migration_drop_assistant_id_columns_v1",
    version: 19,
    dependsOn: ["migration_normalize_assistant_id_to_self_v1"],
    description:
      "Drop assistant_id columns from all 16 daemon tables after normalization to single-tenant identity",
    down: downDropAssistantIdColumns,
  },
  {
    key: "migration_backfill_usage_cache_accounting_v1",
    version: 20,
    description:
      "Backfill historical Anthropic llm_usage_events rows from llm_request_logs with cache-aware pricing",
    down: downBackfillUsageCacheAccounting,
  },
  {
    key: "migration_rename_verification_table_v1",
    version: 21,
    description:
      "Rename channel_guardian_verification_challenges table to channel_verification_sessions and update indexes",
    down: downRenameVerificationTable,
  },
  {
    key: "migration_rename_verification_session_id_column_v1",
    version: 22,
    description:
      "Rename guardian_verification_session_id column in call_sessions to verification_session_id",
    down: downRenameVerificationSessionIdColumn,
  },
  {
    key: "migration_rename_guardian_verification_values_v1",
    version: 23,
    description:
      "Rename persisted guardian_verification call_mode and guardian_voice_verification_* event_type values to drop the guardian_ prefix",
    down: downRenameGuardianVerificationValues,
  },
  {
    key: "migration_rename_voice_to_phone_v1",
    version: 24,
    description:
      'Rename stored "voice" channel values to "phone" across all tables with channel text columns',
    down: downRenameVoiceToPhone,
  },
  {
    key: "migration_drop_accounts_table_v1",
    version: 25,
    description:
      "Drop the unused legacy accounts table and its leftover indexes after account_manage removal",
    down: migrateDropAccountsTableDown,
  },
  {
    key: "migration_reminders_to_schedules_v1",
    version: 26,
    description:
      "Copy all existing reminders into cron_jobs as one-shot schedules with correct status and field mapping",
    down: migrateRemindersToSchedulesDown,
  },
  {
    key: "migration_drop_reminders_table_v1",
    version: 27,
    dependsOn: ["migration_reminders_to_schedules_v1"],
    description:
      "Drop the legacy reminders table and its index after data migration to cron_jobs",
    down: migrateDropRemindersTableDown,
  },
  {
    key: "migration_oauth_apps_client_secret_path_v1",
    version: 28,
    description:
      "Add client_secret_credential_path column to oauth_apps and backfill existing rows with convention-based paths",
    down: migrateOAuthAppsClientSecretPathDown,
  },
  {
    key: "migration_guardian_timestamps_epoch_ms_v1",
    version: 29,
    description:
      "Convert guardian table timestamps from ISO 8601 text to epoch ms integers for consistency with all other tables",
    down: migrateGuardianTimestampsEpochMsDown,
  },
  {
    key: "migration_guardian_timestamps_rebuild_v1",
    version: 30,
    dependsOn: ["migration_guardian_timestamps_epoch_ms_v1"],
    description:
      "Rebuild guardian tables so timestamp columns have INTEGER affinity instead of TEXT",
    down: migrateGuardianTimestampsRebuildDown,
  },
  {
    key: "migration_rename_gmail_provider_key_to_google_v1",
    version: 31,
    description:
      "Rename integration:gmail provider key to integration:google across oauth_providers, oauth_apps, and oauth_connections",
    down: migrateRenameGmailProviderKeyToGoogleDown,
  },
  {
    key: "migration_rename_thread_starters_table_v1",
    version: 32,
    description:
      "Rename thread_starters table to conversation_starters and recreate indexes with new names",
    down: migrateRenameThreadStartersTableDown,
  },
  {
    key: "migration_drop_capability_card_state_v1",
    version: 33,
    dependsOn: ["migration_rename_thread_starters_table_v1"],
    description:
      "Remove deleted capability-card rows, jobs, checkpoints, and category state",
    down: migrateDropCapabilityCardStateDown,
  },
  {
    key: "migration_backfill_inline_attachments_v1",
    version: 34,
    description:
      "Backfill existing inline base64 attachments to on-disk storage and clear dataBase64",
    down: migrateBackfillInlineAttachmentsToDiskDown,
  },
  {
    key: "migration_rename_thread_starters_checkpoints_v1",
    version: 35,
    dependsOn: ["migration_rename_thread_starters_table_v1"],
    description:
      "Rename checkpoint keys from thread_starters: to conversation_starters: prefix so renamed code paths find existing generation state",
    down: migrateRenameThreadStartersCheckpointsDown,
  },
  {
    key: "migration_backfill_audio_attachment_mime_types_v1",
    version: 36,
    description:
      "Backfill correct MIME types for audio attachments stored as application/octet-stream due to missing extension map entries",
    down: migrateBackfillAudioAttachmentMimeTypesDown,
  },
  {
    key: "migration_add_source_type_columns_v1",
    version: 37,
    description:
      "Add source_type and source_message_role columns to memory_items with backfill from verification_state and source messages",
    down: migrateAddSourceTypeColumnsDown,
  },
  {
    key: "migration_strip_integration_prefix_from_provider_keys_v1",
    version: 38,
    description:
      "Strip integration: prefix from provider_key across oauth_providers, oauth_apps, and oauth_connections",
    down: migrateStripIntegrationPrefixFromProviderKeysDown,
  },
  {
    key: "migration_rename_memory_graph_type_values_v1",
    version: 39,
    description:
      "Rename legacy memory graph node type values: style → behavioral, relationship → semantic",
    down: migrateRenameMemoryGraphTypeValuesDown,
  },
  {
    key: "migration_scrub_corrupted_image_attachments_v1",
    version: 40,
    description:
      "Remove image attachments containing HTML error pages instead of image data",
    down: migrateScrubCorruptedImageAttachmentsDown,
  },
  {
    key: "migration_conversation_host_access_v1",
    version: 41,
    description:
      "Add a host_access column to conversations so computer access is persisted per conversation with a safe default of disabled",
    down: downConversationHostAccess,
  },
  {
    key: "migration_normalize_user_file_by_principal_v1",
    version: 42,
    description:
      "Normalize contacts.user_file across rows sharing the same principal_id so every channel for one principal loads the same users/<slug>.md persona and journal directory",
    down: downNormalizeUserFileByPrincipal,
  },
  {
    key: "migration_activation_state_v1",
    version: 43,
    description: "Create activation_state table for memory v2",
    down: downActivationState,
  },
  {
    key: "migration_memory_v2_activation_logs_v1",
    version: 44,
    description:
      "Create memory_v2_activation_logs table for per-turn v2 activation telemetry consumed by the LLM Context Inspector",
    down: downMemoryV2ActivationLogs,
  },
  {
    key: "migration_slack_compaction_watermark_v1",
    version: 45,
    description:
      "Add Slack-specific compaction watermark columns to conversations",
    down: downSlackCompactionWatermark,
  },
  {
    key: "migration_tool_invocations_matched_trust_rule_id_v1",
    version: 46,
    description:
      "Add matched_trust_rule_id column to tool_invocations for trust rule audit and rule editor UI",
    down: downToolInvocationsMatchedRuleId,
  },
];

export function getMaxMigrationVersion(): number {
  return Math.max(...MIGRATION_REGISTRY.map((e) => e.version));
}

export interface MigrationValidationResult {
  /** Keys of migrations whose checkpoint has value 'started' — started but never completed. */
  crashed: string[];
  /** Pairs where a completed migration's declared prerequisite is missing from checkpoints. */
  dependencyViolations: Array<{ migration: string; missingDependency: string }>;
  /** Checkpoint keys present in the database but absent from the migration registry — likely from a newer version. */
  unknownCheckpoints: string[];
}

export interface MigrationRegistryEntry {
  /** The checkpoint key written to memory_checkpoints on completion. */
  key: string;
  /** Monotonic version number used for ordering assertions. */
  version: number;
  /** Keys of other migrations that must complete before this one runs. */
  dependsOn?: string[];
  /** Human-readable description for diagnostics and future authorship guidance. */
  description: string;
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
  },
  {
    key: "migration_memory_entity_relations_dedup_v1",
    version: 2,
    description:
      "Deduplicate entity relation edges before enforcing the (source, target, relation) unique index",
  },
  {
    key: "migration_memory_items_fingerprint_scope_unique_v1",
    version: 3,
    description:
      "Replace column-level UNIQUE on fingerprint with compound (fingerprint, scope_id) unique index",
  },
  {
    key: "migration_memory_items_scope_salted_fingerprints_v1",
    version: 4,
    dependsOn: ["migration_memory_items_fingerprint_scope_unique_v1"],
    description:
      "Recompute memory item fingerprints to include scope_id prefix after schema change",
  },
  {
    key: "migration_normalize_assistant_id_to_self_v1",
    version: 5,
    description:
      'Normalize all assistant_id values in scoped tables to the implicit "self" single-tenant identity',
  },
  {
    key: "migration_remove_assistant_id_columns_v1",
    version: 6,
    dependsOn: ["migration_normalize_assistant_id_to_self_v1"],
    description:
      "Rebuild four tables to drop the assistant_id column after normalization",
  },
  {
    key: "migration_remove_assistant_id_lue_v1",
    version: 7,
    dependsOn: ["migration_normalize_assistant_id_to_self_v1"],
    description:
      "Remove assistant_id column from llm_usage_events (separate checkpoint from the four-table migration)",
  },
  {
    key: "backfill_inbox_thread_state_from_bindings",
    version: 8,
    description:
      "Seed assistant_inbox_thread_state from external_conversation_bindings",
  },
  {
    key: "drop_active_search_index_v1",
    version: 9,
    description:
      "Drop old idx_memory_items_active_search so it can be recreated with updated covering columns",
  },
  {
    key: "migration_notification_tables_schema_v1",
    version: 10,
    description:
      "Drop legacy enum-based notification tables so they can be recreated with the new signal-contract schema",
  },
  {
    key: "migration_rename_macos_ios_channel_to_vellum_v1",
    version: 11,
    description:
      "Rename macos and ios channel identifiers to vellum across all tables",
  },
  {
    key: "migration_embedding_vector_blob_v1",
    version: 12,
    description:
      "Add vector_blob BLOB column to memory_embeddings and backfill from vector_json for compact binary storage",
  },
  {
    key: "migration_embeddings_nullable_vector_json_v1",
    version: 13,
    dependsOn: ["migration_embedding_vector_blob_v1"],
    description:
      "Rebuild memory_embeddings to make vector_json nullable (pre-100 DBs had NOT NULL)",
  },
  {
    key: "migration_normalize_phone_identities_v1",
    version: 14,
    description:
      "Normalize phone-like identity fields to E.164 format across guardian bindings, verification challenges, canonical requests, ingress members, and rate limits",
  },
  {
    key: "migration_backfill_guardian_principal_id_v3",
    version: 15,
    description:
      "Backfill guardianPrincipalId for existing channel_guardian_bindings and canonical_guardian_requests rows, expire unresolvable pending requests",
  },
  {
    key: "migration_guardian_principal_id_not_null_v1",
    version: 16,
    dependsOn: ["migration_backfill_guardian_principal_id_v3"],
    description:
      "Enforce NOT NULL on channel_guardian_bindings.guardian_principal_id after backfill",
  },
  {
    key: "migration_contacts_notes_column_v1",
    version: 17,
    description:
      "Consolidate relationship/importance/response_expectation/preferred_tone into a single notes TEXT column, then drop the legacy columns",
  },
  {
    key: "backfill_contact_interaction_stats",
    version: 18,
    description:
      "Backfill contacts.last_interaction from the max lastSeenAt across each contact's channels",
  },
  {
    key: "migration_drop_assistant_id_columns_v1",
    version: 19,
    dependsOn: ["migration_normalize_assistant_id_to_self_v1"],
    description:
      "Drop assistant_id columns from all 16 daemon tables after normalization to single-tenant identity",
  },
  {
    key: "migration_backfill_usage_cache_accounting_v1",
    version: 20,
    description:
      "Backfill historical Anthropic llm_usage_events rows from llm_request_logs with cache-aware pricing",
  },
  {
    key: "migration_rename_verification_table_v1",
    version: 21,
    description:
      "Rename channel_guardian_verification_challenges table to channel_verification_sessions and update indexes",
  },
  {
    key: "migration_rename_verification_session_id_column_v1",
    version: 22,
    description:
      "Rename guardian_verification_session_id column in call_sessions to verification_session_id",
  },
  {
    key: "migration_rename_guardian_verification_values_v1",
    version: 23,
    description:
      "Rename persisted guardian_verification call_mode and guardian_voice_verification_* event_type values to drop the guardian_ prefix",
  },
  {
    key: "migration_rename_voice_to_phone_v1",
    version: 24,
    description:
      'Rename stored "voice" channel values to "phone" across all tables with channel text columns',
  },
];

export interface MigrationValidationResult {
  /** Keys of migrations whose checkpoint has value 'started' — started but never completed. */
  crashed: string[];
  /** Pairs where a completed migration's declared prerequisite is missing from checkpoints. */
  dependencyViolations: Array<{ migration: string; missingDependency: string }>;
}

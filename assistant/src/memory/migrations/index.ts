export {
  type MigrationRegistryEntry,
  MIGRATION_REGISTRY,
  type MigrationValidationResult,
} from './registry.js';
export { validateMigrationState } from './validate-migration-state.js';
export { migrateJobDeferrals } from './001-job-deferrals.js';
export { migrateToolInvocationsFk } from './002-tool-invocations-fk.js';
export { migrateMemoryFtsBackfill } from './003-memory-fts-backfill.js';
export { migrateMemoryEntityRelationDedup } from './004-entity-relation-dedup.js';
export { migrateMemoryItemsFingerprintScopeUnique } from './005-fingerprint-scope-unique.js';
export { migrateMemoryItemsScopeSaltedFingerprints } from './006-scope-salted-fingerprints.js';
export { migrateAssistantIdToSelf } from './007-assistant-id-to-self.js';
export { migrateRemoveAssistantIdColumns } from './008-remove-assistant-id-columns.js';
export { migrateLlmUsageEventsDropAssistantId } from './009-llm-usage-events-drop-assistant-id.js';
export { migrateExtConvBindingsChannelChatUnique } from './010-ext-conv-bindings-channel-chat-unique.js';
export { migrateCallSessionsProviderSidDedup } from './011-call-sessions-provider-sid-dedup.js';
export { migrateCallSessionsAddInitiatedFrom } from './012-call-sessions-add-initiated-from.js';
export { migrateGuardianActionTables } from './013-guardian-action-tables.js';
export { migrateBackfillInboxThreadStateFromBindings } from './014-backfill-inbox-thread-state.js';
export { migrateDropActiveSearchIndex } from './015-drop-active-search-index.js';
export { migrateMemorySegmentsIndexes } from './016-memory-segments-indexes.js';
export { migrateMemoryItemsIndexes } from './017-memory-items-indexes.js';

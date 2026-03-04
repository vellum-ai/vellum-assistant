import { getDb } from "./db-connection.js";
import { migrateMessagesFtsBackfill } from './migrations/025-messages-fts-backfill.js';
import { migrateGuardianVerificationSessions } from './migrations/026-guardian-verification-sessions.js';
import { migrateGuardianBootstrapToken } from './migrations/027a-guardian-bootstrap-token.js';
import { migrateCallSessionMode } from './migrations/028-call-session-mode.js';
import { migrateChannelInboundDeliveredSegments } from './migrations/029-channel-inbound-delivered-segments.js';
import { migrateGuardianActionFollowup } from './migrations/030-guardian-action-followup.js';
import { migrateGuardianVerificationPurpose } from './migrations/030-guardian-verification-purpose.js';
import { migrateConversationsThreadTypeIndex } from './migrations/031-conversations-thread-type-index.js';
import { migrateGuardianDeliveryConversationIndex } from './migrations/032-guardian-delivery-conversation-index.js';
import { migrateNotificationDeliveryThreadDecision } from './migrations/032-notification-delivery-thread-decision.js';
import { createScopedApprovalGrantsTable } from './migrations/033-scoped-approval-grants.js';
import { migrateGuardianActionToolMetadata } from './migrations/034-guardian-action-tool-metadata.js';
import { migrateGuardianActionSupersession } from './migrations/035-guardian-action-supersession.js';
import { migrateNormalizePhoneIdentities } from './migrations/036-normalize-phone-identities.js';
import { migrateVoiceInviteColumns } from './migrations/037-voice-invite-columns.js';
import { createActorTokenRecordsTable } from './migrations/038-actor-token-records.js';
import { createActorRefreshTokenRecordsTable } from './migrations/039-actor-refresh-token-records.js';
import { createCoreTables } from './migrations/100-core-tables.js';
import { createWatchersAndLogsTables } from './migrations/101-watchers-and-logs.js';
import { addCoreColumns } from './migrations/102-alter-table-columns.js';
import { runComplexMigrations } from './migrations/103-complex-migrations.js';
import { createCoreIndexes } from './migrations/104-core-indexes.js';
import { createContactsAndTriageTables } from './migrations/105-contacts-and-triage.js';
import { createCallSessionsTables } from './migrations/106-call-sessions.js';
import { createFollowupsTables } from './migrations/107-followups.js';
import { createTasksAndWorkItemsTables } from './migrations/108-tasks-and-work-items.js';
import { createExternalConversationBindingsTables } from './migrations/109-external-conversation-bindings.js';
import { createChannelGuardianTables } from './migrations/110-channel-guardian.js';
import { createMediaAssetsTables } from './migrations/111-media-assets.js';
import { createAssistantInboxTables } from './migrations/112-assistant-inbox.js';
import { runLateMigrations } from './migrations/113-late-migrations.js';
import { createNotificationTables } from './migrations/114-notifications.js';
import { createSequenceTables } from './migrations/115-sequences.js';
import { createMessagesFts } from './migrations/116-messages-fts.js';
import { createConversationAttentionTables } from './migrations/117-conversation-attention.js';
import { migrateReminderRoutingIntent } from './migrations/118-reminder-routing-intent.js';
import { migrateSchemaIndexesAndColumns } from './migrations/119-schema-indexes-and-columns.js';
import { migrateFkCascadeRebuilds } from './migrations/120-fk-cascade-rebuilds.js';
import { createCanonicalGuardianTables } from './migrations/121-canonical-guardian-requests.js';
import { migrateCanonicalGuardianRequesterChatId } from './migrations/122-canonical-guardian-requester-chat-id.js';
import { migrateCanonicalGuardianDeliveriesDestinationIndex } from './migrations/123-canonical-guardian-deliveries-destination-index.js';
import { migrateVoiceInviteDisplayMetadata } from './migrations/124-voice-invite-display-metadata.js';
import { migrateGuardianPrincipalIdColumns } from './migrations/125-guardian-principal-id-columns.js';
import { migrateBackfillGuardianPrincipalId } from './migrations/126-backfill-guardian-principal-id.js';
import { migrateGuardianPrincipalIdNotNull } from './migrations/127-guardian-principal-id-not-null.js';
import { migrateContactsRolePrincipal } from './migrations/128-contacts-role-principal.js';
import { migrateContactChannelsAccessFields } from './migrations/129-contact-channels-access-fields.js';
import { migrateContactChannelsTypeChatIdIndex } from './migrations/130-contact-channels-type-ext-chat-id-index.js';
import { recoverCrashedMigrations, validateMigrationState } from './migrations/validate-migration-state.js';

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

  // 14c3. Guardian action supersession metadata (superseded_by_request_id, superseded_at) + session lookup index
  migrateGuardianActionSupersession(database);

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

  // 23. Thread decision audit columns on notification_deliveries
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

  // 34. Composite index on (type, external_chat_id) for updateChannelLastSeenByExternalChatId
  migrateContactChannelsTypeChatIdIndex(database);

  validateMigrationState(database);
}

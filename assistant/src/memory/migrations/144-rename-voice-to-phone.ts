import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Reverse v24: rename "phone" channel values back to "voice" across all
 * tables with channel text columns.
 */
export function downRenameVoiceToPhone(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // contact_channels.type
  raw.exec(
    /*sql*/ `UPDATE contact_channels SET type = 'voice' WHERE type = 'phone'`,
  );

  // conversations.origin_channel
  raw.exec(
    /*sql*/ `UPDATE conversations SET origin_channel = 'voice' WHERE origin_channel = 'phone'`,
  );

  // conversations.origin_interface
  raw.exec(
    /*sql*/ `UPDATE conversations SET origin_interface = 'voice' WHERE origin_interface = 'phone'`,
  );

  // messages.metadata — reverse the JSON string replacement
  raw.exec(
    /*sql*/ `UPDATE messages SET metadata = REPLACE(metadata, '"phone"', '"voice"') WHERE metadata LIKE '%"phone"%'`,
  );

  // assistant_ingress_invites.source_channel
  raw.exec(
    /*sql*/ `UPDATE assistant_ingress_invites SET source_channel = 'voice' WHERE source_channel = 'phone'`,
  );

  // assistant_inbox_thread_state.source_channel
  raw.exec(
    /*sql*/ `UPDATE assistant_inbox_thread_state SET source_channel = 'voice' WHERE source_channel = 'phone'`,
  );

  // guardian_action_requests.source_channel
  raw.exec(
    /*sql*/ `UPDATE guardian_action_requests SET source_channel = 'voice' WHERE source_channel = 'phone'`,
  );

  // guardian_action_requests.answered_by_channel
  raw.exec(
    /*sql*/ `UPDATE guardian_action_requests SET answered_by_channel = 'voice' WHERE answered_by_channel = 'phone'`,
  );

  // channel_verification_sessions.channel (the forward migration ran after v21 rename)
  raw.exec(
    /*sql*/ `UPDATE channel_verification_sessions SET channel = 'voice' WHERE channel = 'phone'`,
  );

  // channel_guardian_approval_requests.channel
  raw.exec(
    /*sql*/ `UPDATE channel_guardian_approval_requests SET channel = 'voice' WHERE channel = 'phone'`,
  );

  // channel_guardian_rate_limits.channel
  // Dedup: remove phone rows that would collide with existing voice rows
  raw.exec(/*sql*/ `DELETE FROM channel_guardian_rate_limits WHERE channel = 'phone' AND EXISTS (
      SELECT 1 FROM channel_guardian_rate_limits AS t2
      WHERE t2.channel = 'voice'
        AND t2.actor_external_user_id = channel_guardian_rate_limits.actor_external_user_id
        AND t2.actor_chat_id = channel_guardian_rate_limits.actor_chat_id
    )`);
  raw.exec(
    /*sql*/ `UPDATE channel_guardian_rate_limits SET channel = 'voice' WHERE channel = 'phone'`,
  );

  // notification_events.source_channel
  raw.exec(
    /*sql*/ `UPDATE notification_events SET source_channel = 'voice' WHERE source_channel = 'phone'`,
  );

  // notification_deliveries.channel
  raw.exec(
    /*sql*/ `UPDATE notification_deliveries SET channel = 'voice' WHERE channel = 'phone'`,
  );

  // external_conversation_bindings.source_channel
  raw.exec(
    /*sql*/ `UPDATE external_conversation_bindings SET source_channel = 'voice' WHERE source_channel = 'phone'`,
  );

  // channel_inbound_events.source_channel
  raw.exec(
    /*sql*/ `UPDATE channel_inbound_events SET source_channel = 'voice' WHERE source_channel = 'phone'`,
  );

  // conversation_attention_events.source_channel
  raw.exec(
    /*sql*/ `UPDATE conversation_attention_events SET source_channel = 'voice' WHERE source_channel = 'phone'`,
  );

  // conversation_assistant_attention_state.last_seen_source_channel
  raw.exec(
    /*sql*/ `UPDATE conversation_assistant_attention_state SET last_seen_source_channel = 'voice' WHERE last_seen_source_channel = 'phone'`,
  );

  // canonical_guardian_requests.source_channel
  raw.exec(
    /*sql*/ `UPDATE canonical_guardian_requests SET source_channel = 'voice' WHERE source_channel = 'phone'`,
  );

  // canonical_guardian_deliveries.destination_channel
  raw.exec(
    /*sql*/ `UPDATE canonical_guardian_deliveries SET destination_channel = 'voice' WHERE destination_channel = 'phone'`,
  );

  // guardian_action_deliveries.destination_channel
  raw.exec(
    /*sql*/ `UPDATE guardian_action_deliveries SET destination_channel = 'voice' WHERE destination_channel = 'phone'`,
  );

  // scoped_approval_grants: request_channel, decision_channel, execution_channel
  raw.exec(
    /*sql*/ `UPDATE scoped_approval_grants SET request_channel = 'voice' WHERE request_channel = 'phone'`,
  );
  raw.exec(
    /*sql*/ `UPDATE scoped_approval_grants SET decision_channel = 'voice' WHERE decision_channel = 'phone'`,
  );
  raw.exec(
    /*sql*/ `UPDATE scoped_approval_grants SET execution_channel = 'voice' WHERE execution_channel = 'phone'`,
  );

  // sequences.channel
  raw.exec(
    /*sql*/ `UPDATE sequences SET channel = 'voice' WHERE channel = 'phone'`,
  );

  // followups.channel
  raw.exec(
    /*sql*/ `UPDATE followups SET channel = 'voice' WHERE channel = 'phone'`,
  );
}

/**
 * One-shot migration: rename stored "voice" channel values to "phone" across
 * all tables that persist channel identifiers as text.
 *
 * This aligns persisted data with the backend rename from "voice" to "phone"
 * as the canonical channel ID for phone/voice calls.
 */
export function migrateRenameVoiceToPhone(database: DrizzleDb): void {
  withCrashRecovery(database, "migration_rename_voice_to_phone_v1", () => {
    const raw = getSqliteFrom(database);

    // contact_channels.type
    raw.exec(
      /*sql*/ `UPDATE contact_channels SET type = 'phone' WHERE type = 'voice'`,
    );

    // conversations.origin_channel
    raw.exec(
      /*sql*/ `UPDATE conversations SET origin_channel = 'phone' WHERE origin_channel = 'voice'`,
    );

    // conversations.origin_interface
    raw.exec(
      /*sql*/ `UPDATE conversations SET origin_interface = 'phone' WHERE origin_interface = 'voice'`,
    );

    // messages.metadata — JSON blobs may contain "voice" as a channel/interface value
    // (e.g. userMessageChannel, provenanceSourceChannel). Replace the quoted JSON
    // string so that messageMetadataSchema (which uses z.enum(CHANNEL_IDS)) can
    // still parse historical rows.
    raw.exec(
      /*sql*/ `UPDATE messages SET metadata = REPLACE(metadata, '"voice"', '"phone"') WHERE metadata LIKE '%"voice"%'`,
    );

    // assistant_ingress_invites.source_channel
    raw.exec(
      /*sql*/ `UPDATE assistant_ingress_invites SET source_channel = 'phone' WHERE source_channel = 'voice'`,
    );

    // assistant_inbox_thread_state.source_channel
    raw.exec(
      /*sql*/ `UPDATE assistant_inbox_thread_state SET source_channel = 'phone' WHERE source_channel = 'voice'`,
    );

    // guardian_action_requests.source_channel
    raw.exec(
      /*sql*/ `UPDATE guardian_action_requests SET source_channel = 'phone' WHERE source_channel = 'voice'`,
    );

    // guardian_action_requests.answered_by_channel
    raw.exec(
      /*sql*/ `UPDATE guardian_action_requests SET answered_by_channel = 'phone' WHERE answered_by_channel = 'voice'`,
    );

    // channel_verification_sessions.channel
    raw.exec(
      /*sql*/ `UPDATE channel_verification_sessions SET channel = 'phone' WHERE channel = 'voice'`,
    );

    // channel_guardian_approval_requests.channel
    raw.exec(
      /*sql*/ `UPDATE channel_guardian_approval_requests SET channel = 'phone' WHERE channel = 'voice'`,
    );

    // channel_guardian_rate_limits.channel
    // Dedup: remove voice rows that would collide with existing phone rows
    // on the UNIQUE index (channel, actor_external_user_id, actor_chat_id).
    raw.exec(/*sql*/ `DELETE FROM channel_guardian_rate_limits WHERE channel = 'voice' AND EXISTS (
        SELECT 1 FROM channel_guardian_rate_limits AS t2
        WHERE t2.channel = 'phone'
          AND t2.actor_external_user_id = channel_guardian_rate_limits.actor_external_user_id
          AND t2.actor_chat_id = channel_guardian_rate_limits.actor_chat_id
      )`);
    raw.exec(
      /*sql*/ `UPDATE channel_guardian_rate_limits SET channel = 'phone' WHERE channel = 'voice'`,
    );

    // notification_events.source_channel
    raw.exec(
      /*sql*/ `UPDATE notification_events SET source_channel = 'phone' WHERE source_channel = 'voice'`,
    );

    // notification_deliveries.channel
    raw.exec(
      /*sql*/ `UPDATE notification_deliveries SET channel = 'phone' WHERE channel = 'voice'`,
    );

    // external_conversation_bindings.source_channel
    raw.exec(
      /*sql*/ `UPDATE external_conversation_bindings SET source_channel = 'phone' WHERE source_channel = 'voice'`,
    );

    // channel_inbound_events.source_channel
    raw.exec(
      /*sql*/ `UPDATE channel_inbound_events SET source_channel = 'phone' WHERE source_channel = 'voice'`,
    );

    // conversation_attention_events.source_channel
    raw.exec(
      /*sql*/ `UPDATE conversation_attention_events SET source_channel = 'phone' WHERE source_channel = 'voice'`,
    );

    // conversation_assistant_attention_state.last_seen_source_channel
    raw.exec(
      /*sql*/ `UPDATE conversation_assistant_attention_state SET last_seen_source_channel = 'phone' WHERE last_seen_source_channel = 'voice'`,
    );

    // canonical_guardian_requests.source_channel
    raw.exec(
      /*sql*/ `UPDATE canonical_guardian_requests SET source_channel = 'phone' WHERE source_channel = 'voice'`,
    );

    // canonical_guardian_deliveries.destination_channel
    raw.exec(
      /*sql*/ `UPDATE canonical_guardian_deliveries SET destination_channel = 'phone' WHERE destination_channel = 'voice'`,
    );

    // guardian_action_deliveries.destination_channel
    raw.exec(
      /*sql*/ `UPDATE guardian_action_deliveries SET destination_channel = 'phone' WHERE destination_channel = 'voice'`,
    );

    // scoped_approval_grants: request_channel, decision_channel, execution_channel
    raw.exec(
      /*sql*/ `UPDATE scoped_approval_grants SET request_channel = 'phone' WHERE request_channel = 'voice'`,
    );
    raw.exec(
      /*sql*/ `UPDATE scoped_approval_grants SET decision_channel = 'phone' WHERE decision_channel = 'voice'`,
    );
    raw.exec(
      /*sql*/ `UPDATE scoped_approval_grants SET execution_channel = 'phone' WHERE execution_channel = 'voice'`,
    );

    // sequences.channel
    raw.exec(
      /*sql*/ `UPDATE sequences SET channel = 'phone' WHERE channel = 'voice'`,
    );

    // followups.channel
    raw.exec(
      /*sql*/ `UPDATE followups SET channel = 'phone' WHERE channel = 'voice'`,
    );
  });
}

import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { migrateDropActiveSearchIndex } from "./015-drop-active-search-index.js";

/**
 * Indexes for query performance on core tables, plus the attachment
 * deduplication migration and its unique index.
 */
export function createCoreIndexes(database: DrizzleDb): void {
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_request_logs_conv_created ON llm_request_logs(conversation_id, created_at)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_tool_invocations_conversation_id ON tool_invocations(conversation_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)`,
  );
  database.run(
    /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_segments_message_segment ON memory_segments(message_id, segment_index)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_segments_conversation_created ON memory_segments(conversation_id, created_at DESC)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_sources_message_id ON memory_item_sources(message_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_conflicts_status_created ON memory_item_conflicts(status, created_at)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_conflicts_status_resolved_at ON memory_item_conflicts(status, resolved_at)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_conflicts_scope_status ON memory_item_conflicts(scope_id, status)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_conflicts_existing_item_id ON memory_item_conflicts(existing_item_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_conflicts_candidate_item_id ON memory_item_conflicts(candidate_item_id)`,
  );
  database.run(/*sql*/ `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_item_conflicts_pending_pair_unique
    ON memory_item_conflicts(scope_id, existing_item_id, candidate_item_id)
    WHERE status = 'pending_clarification'
  `);
  database.run(
    /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_fingerprint_scope ON memory_items(fingerprint, scope_id)`,
  );
  database.run(/*sql*/ `DROP INDEX IF EXISTS idx_memory_items_fingerprint`);
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_items_kind_status ON memory_items(kind, status)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_items_status_invalid_at ON memory_items(status, invalid_at)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_items_scope_status_kind ON memory_items(scope_id, status, kind)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_items_scope_kind_status ON memory_items(scope_id, kind, status)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_items_last_seen_at ON memory_items(last_seen_at)`,
  );
  // Partial covering index for active memory item queries: this index lets SQLite
  // scan only active non-invalidated rows and return columns without touching
  // the main table.
  migrateDropActiveSearchIndex(database);
  database.run(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_items_active_search
    ON memory_items(status, invalid_at, last_seen_at DESC, subject, statement, id, kind, confidence, importance, first_seen_at, scope_id)
    WHERE status = 'active' AND invalid_at IS NULL
  `);
  // Deduplicate — existing DBs may have duplicate (target_type, target_id, provider, model) tuples
  // from before the table-level UNIQUE constraint was enforced. Keep the most recent row per group.
  {
    const rawEmb = getSqliteFrom(database);
    rawEmb.exec(/*sql*/ `
      DELETE FROM memory_embeddings
      WHERE rowid NOT IN (
        SELECT MAX(rowid) FROM memory_embeddings
        GROUP BY target_type, target_id, provider, model
      )
    `);
  }
  database.run(/*sql*/ `DROP INDEX IF EXISTS idx_memory_embeddings_target`);
  database.run(
    /*sql*/ `DROP INDEX IF EXISTS idx_memory_embeddings_provider_model`,
  );
  // Ensure a unique constraint exists on (target_type, target_id, provider, model).
  // New databases get this via the table-level UNIQUE in 100-core-tables.ts (autoindex),
  // but for pre-100 databases where CREATE TABLE IF NOT EXISTS was a no-op, the autoindex
  // doesn't exist. Always create the named index — it's a no-op if it already exists and
  // harmless if an autoindex also covers these columns.
  database.run(
    /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_embeddings_target_provider_model ON memory_embeddings(target_type, target_id, provider, model)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_embeddings_content_hash ON memory_embeddings(content_hash, provider, model)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_jobs_status_run_after ON memory_jobs(status, run_after)`,
  );
  database.run(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_jobs_conflict_resolve_dedupe
    ON memory_jobs(
      type,
      status,
      json_extract(payload, '$.messageId'),
      COALESCE(json_extract(payload, '$.scopeId'), 'default')
    )
  `);
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_summaries_scope_time ON memory_summaries(scope, end_at DESC)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_segments_scope_id ON memory_segments(scope_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_items_scope_id ON memory_items(scope_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_summaries_scope_id ON memory_summaries(scope_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conversation_keys_key ON conversation_keys(conversation_key)`,
  );

  // Deduplicate before creating unique index — existing DBs may have duplicate content_hash values.
  // Re-point message_attachments to the survivor (MIN rowid per content_hash), then delete dupes.
  {
    const raw = getSqliteFrom(database);
    raw.exec(/*sql*/ `
      UPDATE message_attachments
      SET attachment_id = (
        SELECT a_survivor.id
        FROM attachments a_survivor
        WHERE a_survivor.content_hash = (
          SELECT a_dup.content_hash FROM attachments a_dup
          WHERE a_dup.id = message_attachments.attachment_id
        )
        ORDER BY a_survivor.rowid
        LIMIT 1
      )
      WHERE attachment_id IN (
        SELECT id FROM attachments
        WHERE content_hash IS NOT NULL
          AND rowid NOT IN (
            SELECT MIN(rowid) FROM attachments
            WHERE content_hash IS NOT NULL
            GROUP BY content_hash
          )
      )
    `);
    raw.exec(/*sql*/ `
      DELETE FROM attachments
      WHERE content_hash IS NOT NULL
        AND rowid NOT IN (
          SELECT MIN(rowid) FROM attachments
          WHERE content_hash IS NOT NULL
          GROUP BY content_hash
        )
    `);
  }
  database.run(
    /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_content_dedup ON attachments(content_hash) WHERE content_hash IS NOT NULL`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id ON message_attachments(message_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_message_attachments_attachment_id ON message_attachments(attachment_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_inbound_events_lookup ON channel_inbound_events(source_channel, external_chat_id, external_message_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_inbound_events_conversation ON channel_inbound_events(conversation_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_inbound_events_source_msg ON channel_inbound_events(source_channel, external_chat_id, source_message_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_channel_inbound_events_processing_retry ON channel_inbound_events(processing_status, retry_after)`,
  );

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_message_runs_status ON message_runs(status)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_message_runs_conversation ON message_runs(conversation_id)`,
  );

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled_next_run ON cron_jobs(enabled, next_run_at)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_cron_jobs_syntax_enabled_next_run ON cron_jobs(schedule_syntax, enabled, next_run_at)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_cron_runs_job_id ON cron_runs(job_id)`,
  );

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_created_at ON llm_usage_events(created_at)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_provider ON llm_usage_events(provider)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_model ON llm_usage_events(model)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_llm_usage_events_actor ON llm_usage_events(actor)`,
  );

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_shared_app_links_share_token ON shared_app_links(share_token)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_home_base_app_links_app_id ON home_base_app_links(app_id)`,
  );

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_published_pages_html_hash ON published_pages(html_hash)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_published_pages_status ON published_pages(status)`,
  );

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_watchers_enabled_next_poll ON watchers(enabled, next_poll_at)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_watchers_status ON watchers(status)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_watcher_events_watcher_id ON watcher_events(watcher_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_watcher_events_disposition ON watcher_events(disposition)`,
  );

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_entities_name ON memory_entities(name)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_entities_type ON memory_entities(type)`,
  );
  database.run(
    /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entity_relations_unique_edge ON memory_entity_relations(source_entity_id, target_entity_id, relation)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_entity_relations_source ON memory_entity_relations(source_entity_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_entity_relations_target ON memory_entity_relations(target_entity_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_entities_memory_item ON memory_item_entities(memory_item_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_entities_entity ON memory_item_entities(entity_id)`,
  );
}

import type { DrizzleDb } from "../db-connection.js";

/**
 * ALTER TABLE ADD COLUMN migrations for core tables.
 * Each wrapped in try/catch because SQLite throws if the column already exists.
 */
export function addCoreColumns(database: DrizzleDb): void {
  // message_runs
  try {
    database.run(
      /*sql*/ `ALTER TABLE message_runs ADD COLUMN pending_secret TEXT`,
    );
  } catch {
    /* already exists */
  }

  // published_pages
  try {
    database.run(/*sql*/ `ALTER TABLE published_pages ADD COLUMN app_id TEXT`);
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE published_pages ADD COLUMN project_slug TEXT`,
    );
  } catch {
    /* already exists */
  }

  // conversations
  try {
    database.run(
      /*sql*/ `ALTER TABLE conversations ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE conversations ADD COLUMN total_output_tokens INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE conversations ADD COLUMN total_estimated_cost REAL NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE conversations ADD COLUMN context_summary TEXT`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE conversations ADD COLUMN context_compacted_message_count INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE conversations ADD COLUMN context_compacted_at INTEGER`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE conversations ADD COLUMN thread_type TEXT NOT NULL DEFAULT 'standard'`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE conversations ADD COLUMN source TEXT NOT NULL DEFAULT 'user'`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE conversations ADD COLUMN memory_scope_id TEXT NOT NULL DEFAULT 'default'`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE conversations ADD COLUMN origin_channel TEXT`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE conversations ADD COLUMN is_auto_title INTEGER NOT NULL DEFAULT 1`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE conversations ADD COLUMN schedule_job_id TEXT`,
    );
  } catch {
    /* already exists */
  }

  // memory_items
  try {
    database.run(/*sql*/ `ALTER TABLE memory_items ADD COLUMN importance REAL`);
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE memory_items ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE memory_items ADD COLUMN valid_from INTEGER`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE memory_items ADD COLUMN invalid_at INTEGER`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE memory_items ADD COLUMN verification_state TEXT NOT NULL DEFAULT 'assistant_inferred'`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE memory_items ADD COLUMN scope_id TEXT NOT NULL DEFAULT 'default'`,
    );
  } catch {
    /* already exists */
  }

  // memory_summaries
  try {
    database.run(
      /*sql*/ `ALTER TABLE memory_summaries ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE memory_summaries ADD COLUMN scope_id TEXT NOT NULL DEFAULT 'default'`,
    );
  } catch {
    /* already exists */
  }

  // memory_jobs
  try {
    database.run(
      /*sql*/ `ALTER TABLE memory_jobs ADD COLUMN deferrals INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }

  // memory_segments
  try {
    database.run(
      /*sql*/ `ALTER TABLE memory_segments ADD COLUMN scope_id TEXT NOT NULL DEFAULT 'default'`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE memory_segments ADD COLUMN content_hash TEXT`,
    );
  } catch {
    /* already exists */
  }

  // channel_inbound_events
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_inbound_events ADD COLUMN source_message_id TEXT`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_inbound_events ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'pending'`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_inbound_events ADD COLUMN processing_attempts INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_inbound_events ADD COLUMN last_processing_error TEXT`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_inbound_events ADD COLUMN retry_after INTEGER`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_inbound_events ADD COLUMN raw_payload TEXT`,
    );
  } catch {
    /* already exists */
  }

  // attachments
  try {
    database.run(
      /*sql*/ `ALTER TABLE attachments ADD COLUMN content_hash TEXT`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE attachments ADD COLUMN thumbnail_base64 TEXT`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(/*sql*/ `ALTER TABLE attachments ADD COLUMN file_path TEXT`);
  } catch {
    /* already exists */
  }

  // cron_jobs
  try {
    database.run(
      /*sql*/ `ALTER TABLE cron_jobs ADD COLUMN schedule_syntax TEXT NOT NULL DEFAULT 'cron'`,
    );
  } catch {
    /* already exists */
  }

  // messages
  try {
    database.run(/*sql*/ `ALTER TABLE messages ADD COLUMN metadata TEXT`);
  } catch {
    /* already exists */
  }

  // memory_embeddings
  try {
    database.run(
      /*sql*/ `ALTER TABLE memory_embeddings ADD COLUMN content_hash TEXT`,
    );
  } catch {
    /* already exists */
  }
}

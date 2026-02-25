import type { DrizzleDb } from '../db-connection.js';

/**
 * Media assets, processing stages, keyframes, vision outputs,
 * timelines, events, tracking profiles, and event feedback tables with indexes.
 */
export function createMediaAssetsTables(database: DrizzleDb): void {
  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS media_assets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      duration_seconds REAL,
      file_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'registered',
      media_type TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Drop the old non-unique index so it can be recreated as UNIQUE (migration for existing databases)
  database.run(/*sql*/ `DROP INDEX IF EXISTS idx_media_assets_file_hash`);
  database.run(/*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_media_assets_file_hash ON media_assets(file_hash)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_assets_status ON media_assets(status)`);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS processing_stages (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      progress INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      started_at INTEGER,
      completed_at INTEGER
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_processing_stages_asset_id ON processing_stages(asset_id)`);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS media_keyframes (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
      timestamp REAL NOT NULL,
      file_path TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_keyframes_asset_id ON media_keyframes(asset_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_keyframes_asset_timestamp ON media_keyframes(asset_id, timestamp)`);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS media_vision_outputs (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
      keyframe_id TEXT NOT NULL REFERENCES media_keyframes(id) ON DELETE CASCADE,
      analysis_type TEXT NOT NULL,
      output TEXT NOT NULL,
      confidence REAL,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_vision_outputs_asset_id ON media_vision_outputs(asset_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_vision_outputs_keyframe_id ON media_vision_outputs(keyframe_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_vision_outputs_asset_type ON media_vision_outputs(asset_id, analysis_type)`);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS media_timelines (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
      start_time REAL NOT NULL,
      end_time REAL NOT NULL,
      segment_type TEXT NOT NULL,
      attributes TEXT,
      confidence REAL,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_timelines_asset_id ON media_timelines(asset_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_timelines_asset_time ON media_timelines(asset_id, start_time)`);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS media_events (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      start_time REAL NOT NULL,
      end_time REAL NOT NULL,
      confidence REAL NOT NULL,
      reasons TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_events_asset_id ON media_events(asset_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_events_asset_type ON media_events(asset_id, event_type)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_events_confidence ON media_events(confidence DESC)`);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS media_tracking_profiles (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
      capabilities TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_tracking_profiles_asset_id ON media_tracking_profiles(asset_id)`);

  database.run(/*sql*/ `
    CREATE TABLE IF NOT EXISTS media_event_feedback (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL REFERENCES media_events(id) ON DELETE CASCADE,
      feedback_type TEXT NOT NULL,
      original_start_time REAL,
      original_end_time REAL,
      corrected_start_time REAL,
      corrected_end_time REAL,
      notes TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_event_feedback_asset_id ON media_event_feedback(asset_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_event_feedback_event_id ON media_event_feedback(event_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_event_feedback_type ON media_event_feedback(asset_id, feedback_type)`);
}

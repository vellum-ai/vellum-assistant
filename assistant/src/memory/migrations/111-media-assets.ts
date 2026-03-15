import type { DrizzleDb } from "../db-connection.js";

/**
 * Media assets, processing stages, and keyframes tables with indexes.
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
  database.run(
    /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_media_assets_file_hash ON media_assets(file_hash)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_assets_status ON media_assets(status)`,
  );

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

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_processing_stages_asset_id ON processing_stages(asset_id)`,
  );

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

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_keyframes_asset_id ON media_keyframes(asset_id)`,
  );
  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_media_keyframes_asset_timestamp ON media_keyframes(asset_id, timestamp)`,
  );
}

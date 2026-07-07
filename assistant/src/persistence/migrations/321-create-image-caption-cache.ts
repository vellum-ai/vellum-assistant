import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Creates the `image_caption_cache` table: durable image→caption results for
 * the image-fallback plugin, keyed by the sha-256 hash of the image's base64
 * payload.
 *
 * The plugin substitutes text captions for image blocks when the active model
 * is text-only. Raw images stay in persisted history (clients render them),
 * so any path that rebuilds provider-bound context from persistence — a
 * mid-turn compaction, a daemon restart — re-surfaces the same images and
 * re-runs the sweep. This table makes those sweeps lookup-only across
 * restarts instead of re-billing a vision call per image.
 *
 * Purely a cache: rows carry no canonical state, and losing the table only
 * costs re-captioning. The plugin's store bounds row count by evicting the
 * least-recently-used rows on write.
 *
 * Idempotent (`IF NOT EXISTS`). No backfill — captions accumulate as the
 * plugin generates them.
 */
export function migrateCreateImageCaptionCache(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS image_caption_cache (
      image_hash   TEXT PRIMARY KEY,
      caption      TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    )
  `);
  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_image_caption_cache_last_used ON image_caption_cache(last_used_at)`,
  );
}

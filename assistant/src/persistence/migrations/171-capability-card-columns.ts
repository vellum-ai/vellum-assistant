import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateCapabilityCardColumns(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // Add new columns to thread_starters for capability cards
  const newColumns = [
    /*sql*/ `ALTER TABLE thread_starters ADD COLUMN icon TEXT`,
    /*sql*/ `ALTER TABLE thread_starters ADD COLUMN description TEXT`,
    /*sql*/ `ALTER TABLE thread_starters ADD COLUMN tags TEXT`,
    /*sql*/ `ALTER TABLE thread_starters ADD COLUMN card_type TEXT NOT NULL DEFAULT 'chip'`,
  ];

  for (const sql of newColumns) {
    try {
      raw.exec(sql);
    } catch {
      // Column already exists
    }
  }

  // Create capability_card_categories table for per-category relevance tracking
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS capability_card_categories (
      scope_id TEXT NOT NULL,
      category TEXT NOT NULL,
      relevance REAL NOT NULL,
      generation_batch INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (scope_id, category)
    )
  `);

  // Index for card_type filtering
  try {
    raw.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_thread_starters_card_type ON thread_starters (card_type, scope_id)`,
    );
  } catch {
    // Index already exists
  }
}

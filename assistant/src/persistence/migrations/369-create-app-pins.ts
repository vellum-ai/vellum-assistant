import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Creates `app_pins`: which apps the user pinned to the sidebar.
 *
 * A pin is a preference about an app rather than part of one, so it is keyed by
 * app id here instead of living in the app's own on-disk record. That is what
 * lets a plugin app be pinned: its record belongs to the plugin that ships it
 * and the daemon does not write to it.
 *
 * `sort_position` is a fractional index, the same idiom `conversation_groups`
 * uses, so a pin can be placed between two others by averaging their positions
 * instead of renumbering the list.
 *
 * A row holds no display fields. Name and icon are read from the app at list
 * time, so a renamed app renames its pin and a pin whose app is gone reaches
 * no client.
 *
 * Idempotent: `IF NOT EXISTS` on the table and the index.
 */
export function migrateCreateAppPins(db: DrizzleDb): void {
  const raw = getSqliteFrom(db);

  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS app_pins (
      app_id        TEXT PRIMARY KEY,
      sort_position REAL NOT NULL,
      color         TEXT,
      created_at    INTEGER NOT NULL
    )
  `);

  // The only read path: every pin, in sidebar order.
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_app_pins_sort_position ON app_pins(sort_position)`,
  );
}

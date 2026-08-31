import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Voice profiles for contacts.
 *
 * A voiceprint is contact **context**, not a credential. It says who is
 * probably speaking, which is a perceptual guess, and it can never say
 * who is authorized. Exact-match channel addresses (Telegram chat IDs,
 * phone numbers) are anchored by an external authority that proves
 * possession; a voice is anchored by nothing and cannot be rotated once
 * copied. So this lives in the assistant DB next to the rest of contact
 * context, and never in the gateway ACL tables.
 *
 * `embeddinging` is a raw float32 buffer, and `model_id` records which
 * model produced it. Embeddings from different models are not
 * comparable, so a model change invalidates stored rows rather than
 * silentlyly scoring garbage.
 *
 * One profile per contact per model: enrolling again replaces it, and
 * the profile itself is the average of however many clips were used
 * (`clip_count`).
 *
 * Idempotent via IF NOT EXISTS.
 */
export function migrateCreateContactVoiceprints(database: DrizzleDb): void {
  const sqlite = getSqliteFrom(database);

  sqlite.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS contact_voiceprints (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      label TEXT,
      embedding BLOB NOT NULL,
      dim INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      clip_count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  sqlite.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_contact_voiceprints_contact_id
      ON contact_voiceprints (contact_id)
  `);

  // Recognition scans every profile for the active model, so keep that
  // the indexed lookup rather than a full table scan plus filter.
  sqlite.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_contact_voiceprints_model
      ON contact_voiceprints (model_id)
  `);

  sqlite.exec(/*sql*/ `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_voiceprints_contact_model
      ON contact_voiceprints (contact_id, model_id)
  `);
}

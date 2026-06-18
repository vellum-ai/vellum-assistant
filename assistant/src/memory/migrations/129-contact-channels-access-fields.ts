import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Add verification and access-control columns to contact_channels for
 * the unified Contact-centric model. All new nullable columns default
 * to NULL; status and policy get explicit defaults so existing rows
 * are classified as unverified/allow.
 *
 * Uses ALTER TABLE ADD COLUMN with try/catch for idempotency.
 */
export function migrateContactChannelsAccessFields(database: DrizzleDb): void {
  // external_user_id: only add on first run. migration 294 drops this column;
  // if it's absent but other 129-era columns already exist, 294 has run and
  // we must not re-add it (avoids a table-rewrite cycle on every startup).
  const raw = getSqliteFrom(database);
  const cols = raw.prepare("PRAGMA table_info(contact_channels)").all() as {
    name: string;
  }[];
  const colNames = new Set(cols.map((c) => c.name));
  const needsExternalUserId =
    !colNames.has("external_user_id") && !colNames.has("status");
  if (needsExternalUserId) {
    database.run(
      /*sql*/ `ALTER TABLE contact_channels ADD COLUMN external_user_id TEXT`,
    );
  }
  // Delivery/notification routing address (e.g., Telegram chat ID for DMs)
  try {
    database.run(
      /*sql*/ `ALTER TABLE contact_channels ADD COLUMN external_chat_id TEXT`,
    );
  } catch {
    /* already exists */
  }
  // Channel status: 'active' | 'pending' | 'revoked' | 'blocked' | 'unverified'
  try {
    database.run(
      /*sql*/ `ALTER TABLE contact_channels ADD COLUMN status TEXT NOT NULL DEFAULT 'unverified'`,
    );
  } catch {
    /* already exists */
  }
  // Access policy: 'allow' | 'deny' | 'escalate'
  try {
    database.run(
      /*sql*/ `ALTER TABLE contact_channels ADD COLUMN policy TEXT NOT NULL DEFAULT 'allow'`,
    );
  } catch {
    /* already exists */
  }
  // Epoch ms when channel was verified
  try {
    database.run(
      /*sql*/ `ALTER TABLE contact_channels ADD COLUMN verified_at INTEGER`,
    );
  } catch {
    /* already exists */
  }
  // Verification method: 'challenge' | 'invite' | 'bootstrap' | etc.
  try {
    database.run(
      /*sql*/ `ALTER TABLE contact_channels ADD COLUMN verified_via TEXT`,
    );
  } catch {
    /* already exists */
  }
  // Reference to invite that onboarded this channel
  try {
    database.run(
      /*sql*/ `ALTER TABLE contact_channels ADD COLUMN invite_id TEXT`,
    );
  } catch {
    /* already exists */
  }
  // Reason the channel was revoked (set when status = 'revoked')
  try {
    database.run(
      /*sql*/ `ALTER TABLE contact_channels ADD COLUMN revoked_reason TEXT`,
    );
  } catch {
    /* already exists */
  }
  // Reason the channel was blocked (set when status = 'blocked')
  try {
    database.run(
      /*sql*/ `ALTER TABLE contact_channels ADD COLUMN blocked_reason TEXT`,
    );
  } catch {
    /* already exists */
  }
  // Epoch ms of last activity on this channel
  try {
    database.run(
      /*sql*/ `ALTER TABLE contact_channels ADD COLUMN last_seen_at INTEGER`,
    );
  } catch {
    /* already exists */
  }
  // Epoch ms of last modification
  try {
    database.run(
      /*sql*/ `ALTER TABLE contact_channels ADD COLUMN updated_at INTEGER`,
    );
  } catch {
    /* already exists */
  }

  // Only create the index when the column exists (migration 294 drops both).
  if (needsExternalUserId || colNames.has("external_user_id")) {
    database.run(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_contact_channels_type_ext_user ON contact_channels(type, external_user_id)`,
    );
  }
}

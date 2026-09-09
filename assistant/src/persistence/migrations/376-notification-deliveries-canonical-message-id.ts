import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const TABLE = "notification_deliveries";
const COLUMN = "canonical_message_id";

/**
 * Add a nullable `canonical_message_id TEXT` column to
 * `notification_deliveries`.
 *
 * A notification delivered to an external channel is recorded, once the
 * channel acknowledges it, as an assistant row in the chat's conversation.
 * This column names that row from the delivery audit, so the edit and
 * delete paths reach the row without re-running conversation pairing. The
 * existing `message_id` column keeps its meaning: the provider's message id
 * for a channel delivery, the conversation row id for a vellum delivery.
 *
 * `NULL` for rows persisted before this migration ran, for vellum and
 * platform deliveries, and for every channel delivery that did not succeed.
 *
 * Idempotent: the PRAGMA guard makes re-running a no-op once the column
 * exists.
 */
export function migrateNotificationDeliveriesCanonicalMessageId(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  const columns = raw.query(`PRAGMA table_info(${TABLE})`).all() as Array<{
    name: string;
  }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has(COLUMN)) {
    raw.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} TEXT`);
  }
}

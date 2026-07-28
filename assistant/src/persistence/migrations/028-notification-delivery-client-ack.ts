import type { DrizzleDb } from "../db-connection.js";

/**
 * Add client delivery ack columns to notification_deliveries.
 *
 * These columns track the outcome of the macOS/iOS client's attempt to
 * post the notification via UNUserNotificationCenter.add(), providing
 * end-to-end delivery audit fidelity.
 */
export function migrateNotificationDeliveryClientAck(
  database: DrizzleDb,
): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE notification_deliveries ADD COLUMN client_delivery_status TEXT`,
    );
  } catch {
    /* Column already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE notification_deliveries ADD COLUMN client_delivery_error TEXT`,
    );
  } catch {
    /* Column already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE notification_deliveries ADD COLUMN client_delivery_at INTEGER`,
    );
  } catch {
    /* Column already exists */
  }
}

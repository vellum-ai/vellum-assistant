/**
 * One-time migration: deduplicate historical case collisions in the
 * gateway's contact_channels table and restore original platform-provided
 * casing.
 *
 * Historical writes lowercased addresses inconsistently — some paths stored
 * 'U12345' and others stored 'u12345' for the same identity. This migration
 * resolves collisions by keeping the best row per (type, address) group
 * (case-insensitive match for dedup only), then restores original casing
 * from external_user_id into address.
 *
 * Idempotent: on a DB with no case collisions, the DELETE and UPDATE are
 * no-ops.
 */

import { Database } from "bun:sqlite";

import { getLogger } from "../../logger.js";
import { getGatewayDb } from "../connection.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0005-dedup-addresses");

function getRawGatewayDb(): Database {
  return (getGatewayDb() as unknown as { $client: Database }).$client;
}

export function up(): MigrationResult {
  const db = getRawGatewayDb();

  // Deduplicate historical case collisions.
  db.exec(/*sql*/ `
    DELETE FROM contact_channels
    WHERE id NOT IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY type, address COLLATE NOCASE
                 ORDER BY
                   CASE status
                     WHEN 'blocked' THEN 0
                     WHEN 'revoked' THEN 1
                     WHEN 'active' THEN 2
                     WHEN 'unverified' THEN 3
                     ELSE 4
                   END,
                   updated_at DESC
               ) AS rn
        FROM contact_channels
      )
      WHERE rn = 1
    )
  `);

  log.info("Deduplicated contact_channels by (type, address) case-insensitive");

  // Deduplicate by (type, external_user_id) so that a future
  // normalization (SET address = external_user_id) cannot produce collisions.
  db.exec(/*sql*/ `
    DELETE FROM contact_channels
    WHERE external_user_id IS NOT NULL
      AND id NOT IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY type, external_user_id COLLATE NOCASE
                   ORDER BY
                     CASE status
                       WHEN 'blocked' THEN 0
                       WHEN 'revoked' THEN 1
                       WHEN 'active' THEN 2
                       WHEN 'unverified' THEN 3
                       ELSE 4
                     END,
                     updated_at DESC
                 ) AS rn
          FROM contact_channels
          WHERE external_user_id IS NOT NULL
        )
        WHERE rn = 1
      )
  `);

  log.info(
    "Deduplicated contact_channels by (type, external_user_id) case-insensitive",
  );

  // Remove rows that would block future normalization due to cross-column
  // collisions.
  db.exec(/*sql*/ `
    DELETE FROM contact_channels
    WHERE external_user_id IS NULL
      AND id IN (
        SELECT blocker.id
        FROM contact_channels AS blocker
        INNER JOIN contact_channels AS normalizer
          ON normalizer.type = blocker.type
          AND normalizer.external_user_id = blocker.address COLLATE NOCASE
          AND normalizer.address != normalizer.external_user_id
          AND normalizer.external_user_id IS NOT NULL
          AND normalizer.id != blocker.id
      )
  `);

  log.info("Removed cross-column collision blockers");

  // Restore original platform-provided casing from external_user_id.
  // Email addresses stay lowercased (canonical per RFC 5321).
  // UPDATE OR IGNORE as safety net for any remaining edge cases.
  db.exec(/*sql*/ `
    UPDATE OR IGNORE contact_channels
    SET address = external_user_id
    WHERE external_user_id IS NOT NULL
      AND address != external_user_id
      AND type != 'email'
  `);
  db.exec(/*sql*/ `
    UPDATE OR IGNORE contact_channels
    SET address = LOWER(external_user_id)
    WHERE type = 'email'
      AND external_user_id IS NOT NULL
      AND address != LOWER(external_user_id)
  `);

  log.info("Restored original casing from external_user_id into address");

  // Enforce uniqueness at the DB level (defense-in-depth).
  db.exec(/*sql*/ `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_channels_type_address_unique
    ON contact_channels(type, address)
  `);

  log.info("Ensured UNIQUE(type, address) index exists");
  return "done";
}

export function down(): MigrationResult {
  return "done";
}

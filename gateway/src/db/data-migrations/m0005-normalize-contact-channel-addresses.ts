/**
 * One-time migration: deduplicate historical case collisions in the
 * gateway's contact_channels table.
 *
 * Historical writes lowercased addresses inconsistently — some paths stored
 * 'U12345' and others stored 'u12345' for the same identity. This migration
 * resolves collisions by keeping the best row per (type, address) group
 * (case-insensitive match for dedup only).
 *
 * Idempotent: on a DB with no case collisions, the DELETE is a no-op.
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
  return "done";
}

export function down(): MigrationResult {
  return "done";
}

/**
 * One-time migration: normalize all contact_channels.address values to
 * lowercase and deduplicate case-insensitive collisions.
 *
 * Slack channels may have uppercase addresses (e.g. 'U12345ABC') — address
 * is the canonical identity column for all channel types. All lookups query
 * by lowercased address, so uppercase values cause lookup misses.
 *
 * Steps:
 *  1. Deduplicate by (type, LOWER(address)) — keeps the best row per group
 *     using status rank (blocked > revoked > active > unverified) then recency.
 *  2. Lowercase all remaining address values.
 *
 * Idempotent: on a DB where all addresses are already lowercase, both steps
 * are no-ops.
 */

import { Database } from "bun:sqlite";

import { getLogger } from "../../logger.js";
import { getGatewayDb } from "../connection.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0005-normalize-addresses");

function getRawGatewayDb(): Database {
  return (getGatewayDb() as unknown as { $client: Database }).$client;
}

export function up(): MigrationResult {
  const db = getRawGatewayDb();

  // Step 1: Deduplicate by (type, LOWER(address)).
  db.exec(/*sql*/ `
    DELETE FROM contact_channels
    WHERE id NOT IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY type, LOWER(address)
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

  // Step 2: Normalize all addresses to lowercase.
  db.exec(
    /*sql*/ `UPDATE contact_channels SET address = LOWER(address) WHERE address != LOWER(address)`,
  );

  log.info("Normalized contact_channels addresses to lowercase");
  return "done";
}

export function down(): MigrationResult {
  // No-op: lowercased addresses are the correct state going forward.
  return "done";
}

/**
 * One-time migration: recreate `idx_actor_tokens_hash` without the
 * `WHERE status = 'active'` predicate.
 *
 * The hot-path actor-token revocation lookup matches by `token_hash` and must
 * find REVOKED rows, which the old partial index (filtered to active rows)
 * cannot serve. The schema now declares this index unfiltered, but on already-
 * provisioned gateways drizzle-kit `push` does NOT replace an index when only
 * its predicate changes (the name is unchanged), so the old partial definition
 * would persist and the lookup would full-scan. Drop and recreate it
 * explicitly so existing installations get the unfiltered index too.
 *
 * Idempotent: on a fresh DB push already created the unfiltered index, and the
 * DROP/CREATE here reproduces the same definition.
 */

import { Database } from "bun:sqlite";

import { getLogger } from "../../logger.js";
import { getGatewayDb } from "../connection.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0004-actor-token-hash-index");

function getRawGatewayDb(): Database {
  return (getGatewayDb() as unknown as { $client: Database }).$client;
}

export function up(): MigrationResult {
  const db = getRawGatewayDb();
  db.exec("DROP INDEX IF EXISTS idx_actor_tokens_hash");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_actor_tokens_hash ON actor_token_records (token_hash)",
  );
  log.info("Recreated idx_actor_tokens_hash without the status predicate");
  return "done";
}

export function down(): MigrationResult {
  // No-op: leaving the unfiltered index in place on rollback is harmless.
  return "done";
}

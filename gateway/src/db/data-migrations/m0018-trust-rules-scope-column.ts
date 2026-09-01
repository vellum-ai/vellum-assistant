/**
 * One-time migration: add nullable `scope` column to `trust_rules`.
 *
 * The column stores an optional directory path that limits WHERE a rule
 * applies. NULL means global (the pre-migration behaviour for all existing
 * rows). The column was accepted on the wire since the API existed but was
 * silently discarded — this migration persists it going forward.
 *
 * Idempotent: `ADD COLUMN` on an existing column raises SQLITE_ERROR in
 * SQLite; we catch that and treat it as a skip so re-running is safe.
 */

import type { Database } from "bun:sqlite";

import { getLogger } from "../../logger.js";
import { getGatewayDb } from "../connection.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0018-trust-rules-scope-column");

function getRawGatewayDb(): Database {
  return (getGatewayDb() as unknown as { $client: Database }).$client;
}

export function up(): MigrationResult {
  try {
    getRawGatewayDb()
      .prepare(/*sql*/ `ALTER TABLE trust_rules ADD COLUMN scope TEXT`)
      .run();

    log.info("Added scope column to trust_rules");
    return "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("duplicate column name")) {
      log.info("scope column already exists in trust_rules — skipping");
      return "done";
    }
    log.error({ err }, "Failed to add scope column to trust_rules");
    return "skip";
  }
}

export function down(): MigrationResult {
  return "done";
}

/**
 * One-time migration: drop the gateway `channel_verification_sessions` table.
 *
 * The assistant DB owns verification session state; the gateway copy took a
 * single write that never had a matching insert, so the table only ever held
 * empty carry-cost. A future gateway-SoT move recreates this table
 * deliberately with its own read/write paths.
 *
 * Runs on the gateway's own DB (plain SQL). Idempotent via IF EXISTS.
 */

import { Database } from "bun:sqlite";

import { getLogger } from "../../logger.js";
import { getGatewayDb } from "../connection.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0011-drop-gw-verification-sessions");

function getRawGatewayDb(): Database {
  return (getGatewayDb() as unknown as { $client: Database }).$client;
}

export function up(): MigrationResult {
  getRawGatewayDb().exec("DROP TABLE IF EXISTS channel_verification_sessions");
  log.info("Dropped gateway channel_verification_sessions mirror table");
  return "done";
}

export function down(): MigrationResult {
  // No-op: the assistant DB owns session state; the gateway mirror is not restored.
  return "done";
}

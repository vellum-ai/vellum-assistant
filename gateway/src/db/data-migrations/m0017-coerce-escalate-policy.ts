/**
 * One-time migration: coerce stale contact_channels.policy = 'escalate'
 * rows to 'deny'.
 *
 * The escalate channel policy is removed; the column has no CHECK, so rows
 * written before the vocabulary shrank to allow|deny can persist. 'deny'
 * preserves the fail-closed posture and the feature's observed behavior
 * (escalated messages were never delivered), and the guardian can flip the
 * row to allow.
 *
 * Idempotent: on a DB with no escalate rows, the UPDATE is a no-op.
 */

import { Database } from "bun:sqlite";

import { getLogger } from "../../logger.js";
import { getGatewayDb } from "../connection.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0017-coerce-escalate-policy");

function getRawGatewayDb(): Database {
  return (getGatewayDb() as unknown as { $client: Database }).$client;
}

export function up(): MigrationResult {
  try {
    const { changes } = getRawGatewayDb()
      .prepare(
        /*sql*/ `
          UPDATE contact_channels
             SET policy = 'deny', updated_at = ?
           WHERE policy = 'escalate'
        `,
      )
      .run(Date.now());

    if (changes > 0) {
      log.info(
        { coerced: changes },
        "Coerced stale escalate channel policies to deny",
      );
    }
    return "done";
  } catch (err) {
    log.error(
      { err },
      "Escalate-policy coercion failed — will retry on next startup",
    );
    return "skip";
  }
}

export function down(): MigrationResult {
  return "done";
}

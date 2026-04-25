/**
 * One-time migration: migrate actor_token_records and
 * actor_refresh_token_records from the assistant's SQLite database into
 * the gateway's SQLite database, then drop the tables from the assistant DB.
 *
 * After this migration:
 *   - The gateway DB is the sole owner of both tables.
 *   - All reads/writes go through the gateway DB only (no dual-writes).
 *   - The assistant DB no longer has these tables.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { getGatewayDb } from "../connection.js";
import { getLogger } from "../../logger.js";
import { getWorkspaceDir } from "../../paths.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0002-actor-token-tables-to-gateway");

function getAssistantDbPath(): string {
  return join(getWorkspaceDir(), "data", "db", "assistant.db");
}

function getRawGatewayDb(): Database {
  return (getGatewayDb() as unknown as { $client: Database }).$client;
}

export function up(): MigrationResult {
  const assistantDbPath = getAssistantDbPath();
  if (!existsSync(assistantDbPath)) {
    log.info("Assistant database not found — nothing to migrate");
    return "done";
  }

  const gwDb = getRawGatewayDb();
  let assistantDb: Database | null = null;
  try {
    assistantDb = new Database(assistantDbPath);
    assistantDb.exec("PRAGMA journal_mode=WAL");
    assistantDb.exec("PRAGMA busy_timeout=5000");

    const hasActorTokens = assistantDb
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'actor_token_records'`,
      )
      .get();

    const hasRefreshTokens = assistantDb
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'actor_refresh_token_records'`,
      )
      .get();

    if (!hasActorTokens && !hasRefreshTokens) {
      log.info(
        "Neither actor token table exists in assistant DB — nothing to migrate",
      );
      return "done";
    }

    // --- Migrate actor_token_records ---
    if (hasActorTokens) {
      interface ActorTokenRow {
        id: string;
        token_hash: string;
        guardian_principal_id: string;
        hashed_device_id: string;
        platform: string;
        status: string;
        issued_at: number;
        expires_at: number | null;
        created_at: number;
        updated_at: number;
      }

      const rows = assistantDb
        .query<ActorTokenRow, []>(
          `SELECT id, token_hash, guardian_principal_id, hashed_device_id,
                  platform, status, issued_at, expires_at, created_at, updated_at
           FROM actor_token_records`,
        )
        .all();

      if (rows.length > 0) {
        const insert = gwDb.prepare(
          `INSERT OR REPLACE INTO actor_token_records
             (id, token_hash, guardian_principal_id, hashed_device_id,
              platform, status, issued_at, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        const txn = gwDb.transaction(() => {
          for (const row of rows) {
            insert.run(
              row.id,
              row.token_hash,
              row.guardian_principal_id,
              row.hashed_device_id,
              row.platform,
              row.status,
              row.issued_at,
              row.expires_at,
              row.created_at,
              row.updated_at,
            );
          }
        });
        txn();
        log.info(
          { count: rows.length },
          "Migrated actor_token_records to gateway DB",
        );
      }

      assistantDb.exec(`DROP TABLE IF EXISTS actor_token_records`);
      log.info("Dropped actor_token_records from assistant DB");
    }

    // --- Migrate actor_refresh_token_records ---
    if (hasRefreshTokens) {
      interface RefreshTokenRow {
        id: string;
        token_hash: string;
        family_id: string;
        guardian_principal_id: string;
        hashed_device_id: string;
        platform: string;
        status: string;
        issued_at: number;
        absolute_expires_at: number;
        inactivity_expires_at: number;
        last_used_at: number | null;
        created_at: number;
        updated_at: number;
      }

      const rows = assistantDb
        .query<RefreshTokenRow, []>(
          `SELECT id, token_hash, family_id, guardian_principal_id, hashed_device_id,
                  platform, status, issued_at, absolute_expires_at, inactivity_expires_at,
                  last_used_at, created_at, updated_at
           FROM actor_refresh_token_records`,
        )
        .all();

      if (rows.length > 0) {
        const insert = gwDb.prepare(
          `INSERT OR REPLACE INTO actor_refresh_token_records
             (id, token_hash, family_id, guardian_principal_id, hashed_device_id,
              platform, status, issued_at, absolute_expires_at, inactivity_expires_at,
              last_used_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        const txn = gwDb.transaction(() => {
          for (const row of rows) {
            insert.run(
              row.id,
              row.token_hash,
              row.family_id,
              row.guardian_principal_id,
              row.hashed_device_id,
              row.platform,
              row.status,
              row.issued_at,
              row.absolute_expires_at,
              row.inactivity_expires_at,
              row.last_used_at,
              row.created_at,
              row.updated_at,
            );
          }
        });
        txn();
        log.info(
          { count: rows.length },
          "Migrated actor_refresh_token_records to gateway DB",
        );
      }

      assistantDb.exec(`DROP TABLE IF EXISTS actor_refresh_token_records`);
      log.info("Dropped actor_refresh_token_records from assistant DB");
    }

    return "done";
  } catch (err) {
    log.error(
      { err },
      "Actor token migration failed — will retry on next startup",
    );
    return "skip";
  } finally {
    if (assistantDb) {
      try {
        assistantDb.close();
      } catch {
        // best effort
      }
    }
  }
}

export function down(): MigrationResult {
  // No-op: we don't move data back to the assistant DB on rollback.
  return "done";
}

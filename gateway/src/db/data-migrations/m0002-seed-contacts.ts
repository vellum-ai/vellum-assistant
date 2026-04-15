/**
 * One-time migration: seed `contacts` and `contact_channels` from
 * the assistant's database (`assistant.db`) into the gateway database.
 *
 * After this migration runs, the gateway owns the canonical copy of
 * contact auth/authz data. The assistant daemon reads it via IPC.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { getWorkspaceDir } from "../../credential-reader.js";
import { getLogger } from "../../logger.js";
import { getGatewayDb } from "../connection.js";

import type { MigrationResult } from "./index.js";

const log = getLogger("m0002-seed-contacts");

function getAssistantDbPath(): string {
  return join(getWorkspaceDir(), "data", "db", "assistant.db");
}

export function up(): MigrationResult {
  const assistantDbPath = getAssistantDbPath();

  if (!existsSync(assistantDbPath)) {
    log.info("No assistant.db found — nothing to seed");
    return "done";
  }

  let assistantDb: Database;
  try {
    assistantDb = new Database(assistantDbPath, { readonly: true });
  } catch (err) {
    log.error({ err }, "Failed to open assistant.db — will retry");
    return "skip";
  }

  try {
    const gatewayDb = getGatewayDb();

    // Check if the contacts table exists in assistant.db
    const tableCheck = assistantDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contacts'",
      )
      .get() as { name: string } | null;

    if (!tableCheck) {
      log.info("No contacts table in assistant.db — nothing to seed");
      return "done";
    }

    const contacts = assistantDb
      .prepare(
        `SELECT id, display_name, notes, role, principal_id, user_file, contact_type, created_at, updated_at
         FROM contacts`,
      )
      .all() as {
      id: string;
      display_name: string;
      notes: string | null;
      role: string;
      principal_id: string | null;
      user_file: string | null;
      contact_type: string;
      created_at: number;
      updated_at: number;
    }[];

    const channelTableCheck = assistantDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contact_channels'",
      )
      .get() as { name: string } | null;

    const channels = channelTableCheck
      ? (assistantDb
          .prepare(
            `SELECT id, contact_id, type, address, is_primary, external_user_id,
                    external_chat_id, status, policy, verified_at, verified_via,
                    invite_id, revoked_reason, blocked_reason, last_seen_at,
                    interaction_count, last_interaction, created_at, updated_at
             FROM contact_channels`,
          )
          .all() as {
          id: string;
          contact_id: string;
          type: string;
          address: string;
          is_primary: number;
          external_user_id: string | null;
          external_chat_id: string | null;
          status: string;
          policy: string;
          verified_at: number | null;
          verified_via: string | null;
          invite_id: string | null;
          revoked_reason: string | null;
          blocked_reason: string | null;
          last_seen_at: number | null;
          interaction_count: number;
          last_interaction: number | null;
          created_at: number;
          updated_at: number | null;
        }[])
      : [];

    // Insert everything inside a single transaction for atomicity
    gatewayDb.exec("BEGIN IMMEDIATE");
    try {
      const insertContact = gatewayDb.prepare(
        `INSERT OR IGNORE INTO contacts
           (id, display_name, notes, role, principal_id, user_file, contact_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const c of contacts) {
        insertContact.run(
          c.id,
          c.display_name,
          c.notes,
          c.role,
          c.principal_id,
          c.user_file,
          c.contact_type,
          c.created_at,
          c.updated_at,
        );
      }

      const insertChannel = gatewayDb.prepare(
        `INSERT OR IGNORE INTO contact_channels
           (id, contact_id, type, address, is_primary, external_user_id,
            external_chat_id, status, policy, verified_at, verified_via,
            invite_id, revoked_reason, blocked_reason, last_seen_at,
            interaction_count, last_interaction, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const ch of channels) {
        insertChannel.run(
          ch.id,
          ch.contact_id,
          ch.type,
          ch.address,
          ch.is_primary,
          ch.external_user_id,
          ch.external_chat_id,
          ch.status,
          ch.policy,
          ch.verified_at,
          ch.verified_via,
          ch.invite_id,
          ch.revoked_reason,
          ch.blocked_reason,
          ch.last_seen_at,
          ch.interaction_count,
          ch.last_interaction,
          ch.created_at,
          ch.updated_at,
        );
      }

      gatewayDb.exec("COMMIT");

      log.info(
        { contacts: contacts.length, channels: channels.length },
        "Seeded contacts and contact_channels from assistant.db",
      );
    } catch (err) {
      gatewayDb.exec("ROLLBACK");
      throw err;
    }

    return "done";
  } catch (err) {
    log.error({ err }, "Failed to seed contacts — will retry");
    return "skip";
  } finally {
    assistantDb.close();
  }
}

export function down(): MigrationResult {
  return "done";
}

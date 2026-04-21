import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import type { WorkspaceMigration } from "./types.js";

const GMAIL_SETTINGS_BASIC_SCOPE =
  "https://www.googleapis.com/auth/gmail.settings.basic";

/**
 * Re-run the gmail.settings.basic scope backfill with correct SQLite column names.
 *
 * Migration 041 used Drizzle property names (`defaultScopes`, `provider`,
 * `updatedAt`) instead of the actual SQLite column names (`default_scopes`,
 * `provider_key`, `updated_at`). The SQL silently failed because the catch
 * block swallowed the error, and the migration was marked complete without
 * actually backfilling the scope.
 *
 * This migration performs the same backfill with the correct column names.
 */
export const fixBackfillGoogleGmailSettingsScopeMigration: WorkspaceMigration =
  {
    id: "042-fix-backfill-google-gmail-settings-scope",
    description:
      "Re-run gmail.settings.basic scope backfill with correct SQLite column names",
    run(workspaceDir: string): void {
      const dbPath = join(workspaceDir, "data", "db", "assistant.db");
      if (!existsSync(dbPath)) return; // DB not created yet — nothing to backfill.

      let db: Database;
      try {
        db = new Database(dbPath);
      } catch {
        // Cannot open DB — nothing to backfill.
        return;
      }

      try {
        const row = db
          .query(
            `SELECT default_scopes FROM oauth_providers WHERE provider_key = 'google'`,
          )
          .get() as { default_scopes: string } | null;

        if (!row) return; // No google provider row — seed will create it fresh.

        let scopes: string[];
        try {
          const parsed = JSON.parse(row.default_scopes);
          scopes = Array.isArray(parsed) ? parsed : [];
        } catch {
          scopes = [];
        }

        if (scopes.includes(GMAIL_SETTINGS_BASIC_SCOPE)) return; // Already present.

        scopes.push(GMAIL_SETTINGS_BASIC_SCOPE);

        db.query(
          `UPDATE oauth_providers SET default_scopes = ?, updated_at = ? WHERE provider_key = 'google'`,
        ).run(JSON.stringify(scopes), Date.now());
      } finally {
        db.close();
      }
    },
    down(_workspaceDir: string): void {
      // Forward-only: removing the scope would break Gmail settings functionality
      // for users who have already started using it.
    },
  };

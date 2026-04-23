import { rawGet, rawRun } from "../../memory/raw-query.js";
import type { WorkspaceMigration } from "./types.js";

const GMAIL_SETTINGS_BASIC_SCOPE =
  "https://www.googleapis.com/auth/gmail.settings.basic";

/**
 * Backfill the `gmail.settings.basic` scope for existing Google provider rows.
 *
 * The scope was added to PROVIDER_SEED_DATA in #25970. This migration ensures
 * existing workspace rows that were created before the seed update also include
 * the scope.
 *
 * This migration reads the current `defaultScopes` JSON array for the `google`
 * provider and appends the scope if it is not already present.
 */
export const backfillGoogleGmailSettingsScopeMigration: WorkspaceMigration = {
  id: "041-backfill-google-gmail-settings-scope",
  description:
    "Backfill gmail.settings.basic scope for existing Google provider rows",
  run(_workspaceDir: string): void {
    let row: { defaultScopes: string } | null;
    try {
      row = rawGet<{ defaultScopes: string }>(
        `SELECT defaultScopes FROM oauth_providers WHERE provider = 'google'`,
      );
    } catch {
      // DB not initialized yet — nothing to backfill.
      return;
    }

    if (!row) return; // No google provider row — seed will create it fresh.

    let scopes: string[];
    try {
      const parsed = JSON.parse(row.defaultScopes);
      scopes = Array.isArray(parsed) ? parsed : [];
    } catch {
      scopes = [];
    }

    if (scopes.includes(GMAIL_SETTINGS_BASIC_SCOPE)) return; // Already present.

    scopes.push(GMAIL_SETTINGS_BASIC_SCOPE);

    rawRun(
      `UPDATE oauth_providers SET defaultScopes = ?, updatedAt = ? WHERE provider = 'google'`,
      JSON.stringify(scopes),
      new Date().toISOString(),
    );
  },
  down(_workspaceDir: string): void {
    // Forward-only: removing the scope would break Gmail settings functionality
    // for users who have already started using it.
  },
};

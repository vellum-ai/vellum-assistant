import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("migrations/140-normalize-managed-connection-rows");

// Platform auth and provider "vellum" record the same fact (the managed,
// platform-billed route) in two columns of `provider_connections`. The
// connection routes derive them together and reject writes that split them,
// but rows written before that guard can still disagree. Reconcile them so
// the provider column alone identifies the managed route:
//
// - Platform auth with any other provider: the provider becomes "vellum".
//   These rows dispatch through the managed proxy (transport selection keys
//   on the managed identity), so normalizing the provider preserves billing
//   and transport behavior, while normalizing the auth instead would
//   silently turn a platform-billed row into a keyless BYOK row. This also
//   heals a stuck pre-consolidation canonical row (name "vellum", concrete
//   provider, platform auth) that boot seeding skips because its provider
//   differs from the sentinel.
// - Provider "vellum" with any other auth: the auth becomes
//   `{"type":"platform"}`. A vellum row means the managed route by
//   definition, and non-platform auth on it never yields a usable adapter.
//
// Rows whose auth column is not valid JSON are left alone (the DB loaders
// already treat them as invalid). Idempotent: a reconciled row matches
// neither rule.

const VELLUM_PROVIDER = "vellum";
const PLATFORM_AUTH_JSON = JSON.stringify({ type: "platform" });

export const normalizeManagedConnectionRowsMigration: WorkspaceMigration = {
  id: "140-normalize-managed-connection-rows",
  description:
    'Reconcile provider_connections rows so platform auth and provider "vellum" always pair',
  run(workspaceDir: string): void {
    const dbPath = join(workspaceDir, "data", "db", "assistant.db");
    if (!existsSync(dbPath)) {
      return; // DB not created yet: nothing to reconcile.
    }

    let db: Database;
    try {
      db = new Database(dbPath);
    } catch {
      return; // Cannot open DB: nothing to reconcile.
    }

    try {
      let rows: Array<{ name: string; provider: string; auth: string }>;
      try {
        rows = db
          .query(`SELECT name, provider, auth FROM provider_connections`)
          .all() as Array<{ name: string; provider: string; auth: string }>;
      } catch {
        return; // Table not created yet: nothing to reconcile.
      }

      const now = Date.now();
      for (const row of rows) {
        let authType: unknown;
        try {
          const parsed: unknown = JSON.parse(row.auth);
          authType =
            parsed !== null && typeof parsed === "object"
              ? (parsed as { type?: unknown }).type
              : undefined;
        } catch {
          continue; // Unparseable auth: leave the row alone.
        }

        if (authType === "platform" && row.provider !== VELLUM_PROVIDER) {
          db.query(
            `UPDATE provider_connections SET provider = ?, updated_at = ? WHERE name = ?`,
          ).run(VELLUM_PROVIDER, now, row.name);
          log.info(
            { name: row.name, previousProvider: row.provider },
            "Rewrote platform-auth connection row to provider vellum",
          );
        } else if (
          row.provider === VELLUM_PROVIDER &&
          authType !== "platform"
        ) {
          db.query(
            `UPDATE provider_connections SET auth = ?, updated_at = ? WHERE name = ?`,
          ).run(PLATFORM_AUTH_JSON, now, row.name);
          log.info(
            { name: row.name, previousAuthType: authType },
            "Rewrote vellum connection row to platform auth",
          );
        }
      }
    } finally {
      db.close();
    }
  },
  down(_workspaceDir: string): void {
    // Forward-only.
  },
};

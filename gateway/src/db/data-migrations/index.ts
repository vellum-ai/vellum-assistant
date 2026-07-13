/**
 * One-time data migrations that run after schema setup on gateway startup.
 *
 * Each migration is guarded by the `one_time_migrations` table: once a
 * migration key is recorded, it never runs again. Migrations execute
 * sequentially in filename order.
 *
 * To add a data migration:
 *   1. Create `m<NNNN>-<name>.ts` in this folder exporting up() and down().
 *   2. Import it below and append an entry to STATIC_MIGRATIONS.
 *
 * Static registration is required because the gateway is compiled into a
 * native binary for macOS distribution via `bun build --compile`. In a
 * compiled Bun binary, `import.meta.dirname` resolves to the virtual
 * filesystem and `readdirSync` throws ENOENT.
 */

import type { Database } from "bun:sqlite";

import { getLogger } from "../../logger.js";

import * as m0001 from "./m0001-guardian-init-lock.js";
import * as m0002 from "./m0002-actor-token-tables-to-gateway.js";
import * as m0003 from "./m0003-recover-backup-key.js";
import * as m0004 from "./m0004-actor-token-hash-index-unfiltered.js";
import * as m0005 from "./m0005-normalize-contact-channel-addresses.js";
import * as m0006 from "./m0006-reconcile-contacts-from-assistant.js";
import * as m0007 from "./m0007-backfill-ingress-invites.js";
import * as m0008 from "./m0008-upsert-acl-columns-from-assistant.js";
import * as m0009 from "./m0009-invite-fields-backfill.js";
import * as m0010 from "./m0010-drop-assistant-ingress-invites.js";
import * as m0011 from "./m0011-drop-gw-verification-sessions.js";
import * as m0012 from "./m0012-migrate-slack-channel-permissions.js";
import * as m0013 from "./m0013-verification-sessions-backfill.js";
import * as m0014 from "./m0014-drop-assistant-verification-tables.js";
import * as m0015 from "./m0015-guardian-requests-backfill.js";
import * as m0016 from "./m0016-drop-assistant-guardian-tables.js";

const log = getLogger("data-migrations");

export type MigrationResult = "done" | "skip";

type MigrationModule = {
  up: () => MigrationResult | Promise<MigrationResult>;
  down: () => MigrationResult | Promise<MigrationResult>;
};

/** Exported for ordering assertions in tests. */
export const MIGRATIONS: { key: string; mod: MigrationModule }[] = [
  { key: "m0001-guardian-init-lock", mod: m0001 },
  { key: "m0002-actor-token-tables-to-gateway", mod: m0002 },
  { key: "m0003-recover-backup-key", mod: m0003 },
  { key: "m0004-actor-token-hash-index-unfiltered", mod: m0004 },
  { key: "m0005-normalize-contact-channel-addresses", mod: m0005 },
  { key: "m0006-reconcile-contacts-from-assistant", mod: m0006 },
  { key: "m0007-backfill-ingress-invites", mod: m0007 },
  { key: "m0008-upsert-acl-columns-from-assistant", mod: m0008 },
  { key: "m0009-invite-fields-backfill", mod: m0009 },
  // m0010 must stay after m0009: it drops the assistant table m0009 reads.
  { key: "m0010-drop-assistant-ingress-invites", mod: m0010 },
  { key: "m0011-drop-gw-verification-sessions", mod: m0011 },
  { key: "m0012-migrate-slack-channel-permissions", mod: m0012 },
  { key: "m0013-verification-sessions-backfill", mod: m0013 },
  // m0014 must stay after m0013: it drops the assistant tables m0013 reads.
  { key: "m0014-drop-assistant-verification-tables", mod: m0014 },
  { key: "m0015-guardian-requests-backfill", mod: m0015 },
  // m0016 must stay after m0015: it drops the assistant tables m0015 reads.
  { key: "m0016-drop-assistant-guardian-tables", mod: m0016 },
];

/**
 * Execute any one-time data migrations that haven't run yet.
 * Must be called after schema migrations so the `one_time_migrations`
 * table exists.
 */
export async function runDataMigrations(db: Database): Promise<void> {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO one_time_migrations (key, ran_at) VALUES (?, ?)",
  );

  for (const { key, mod } of MIGRATIONS) {
    const row = db
      .prepare("SELECT 1 FROM one_time_migrations WHERE key = ?")
      .get(key) as Record<string, unknown> | null;

    if (row) continue;

    log.info({ key }, "Running one-time data migration");
    try {
      const result = await mod.up();
      if (result === "done") {
        insert.run(key, Date.now());
        log.info({ key }, "Data migration completed");
      } else {
        log.info(
          { key },
          "Data migration skipped — will retry on next startup",
        );
      }
    } catch (err) {
      log.error(
        { err, key },
        "Data migration failed — will retry on next startup",
      );
    }
  }
}

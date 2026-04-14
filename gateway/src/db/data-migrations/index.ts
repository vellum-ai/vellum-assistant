/**
 * One-time data migrations that run after schema setup on gateway startup.
 *
 * Each migration is guarded by the `one_time_migrations` table: once a
 * migration key is recorded, it never runs again. Migrations execute
 * sequentially in the order they are registered in the MIGRATIONS array.
 *
 * To add a data migration:
 *   1. Create `m<NNNN>_<name>.ts` in this folder exporting up() and down().
 *   2. Import it here and append `{ key: "m<NNNN>_<name>", mod }` to MIGRATIONS.
 *
 * Migrations are registered statically (not discovered via readdirSync) so
 * this module works inside a Bun-compiled binary, where `import.meta.dir`
 * resolves to the virtual filesystem and `readdirSync` throws ENOENT.
 */

import type { Database } from "bun:sqlite";

import { getLogger } from "../../logger.js";

const log = getLogger("data-migrations");

export type MigrationResult = "done" | "skip";

type MigrationModule = {
  up: () => MigrationResult;
  down: () => MigrationResult;
};

const MIGRATIONS: { key: string; mod: MigrationModule }[] = [];

/**
 * Execute any one-time data migrations that haven't run yet.
 * Must be called after schema migrations so the `one_time_migrations`
 * table exists.
 */
export function runDataMigrations(db: Database): void {
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
      const result = mod.up();
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

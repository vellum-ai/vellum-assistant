/**
 * One-time data migrations that run after schema setup on gateway startup.
 *
 * Each migration is guarded by the `one_time_migrations` table: once a
 * migration key is recorded, it never runs again. Migrations execute
 * sequentially in filename order (m0001, m0002, …).
 *
 * Each migration file exports:
 *   up()   — run the migration forward; return "done" or "skip"
 *   down() — reverse the migration; return "done" or "skip"
 */

import type { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../logger.js";

const log = getLogger("data-migrations");

export type MigrationResult = "done" | "skip";

type MigrationModule = {
  up: () => MigrationResult;
  down: () => MigrationResult;
};

function discoverMigrations(): { key: string; mod: MigrationModule }[] {
  const dir = import.meta.dir;
  const files = readdirSync(dir)
    .filter((f) => /^m\d+.*\.(ts|js)$/.test(f) && !f.endsWith(".d.ts"))
    .sort();

  return files.map((f) => {
    const key = f.replace(/\.(ts|js)$/, "");
    // Using require() for synchronous loading — these run at startup before
    // any requests are served, so async is unnecessary.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(join(dir, f)) as MigrationModule;
    return { key, mod };
  });
}

/**
 * Execute any one-time data migrations that haven't run yet.
 * Must be called after schema migrations so the `one_time_migrations`
 * table exists.
 */
export function runDataMigrations(db: Database): void {
  const migrations = discoverMigrations();

  const insert = db.prepare(
    "INSERT OR IGNORE INTO one_time_migrations (key, ran_at) VALUES (?, ?)",
  );

  for (const { key, mod } of migrations) {
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
      // Don't insert the key so it retries next time
    }
  }
}

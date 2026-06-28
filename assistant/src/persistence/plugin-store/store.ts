/**
 * Plugin-owned durable structured store, backed by namespaced tables in the
 * shared assistant database.
 *
 * A plugin declares append-only migrations (table DDL) and then runs typed
 * `query`/`exec` against its own `plugin_<id>_`-prefixed tables. Two boundaries
 * are enforced here:
 *
 * - **Namespace isolation.** Every statement is validated against the plugin's
 *   prefix (see `assertScopedToPlugin`); a statement touching another plugin's
 *   tables or the core schema throws.
 * - **Migration checkpointing.** Migrations are recorded in the shared
 *   `memory_checkpoints` ledger under a plugin-scoped namespace
 *   (`plugin-step:<hostId>:<name>`), entirely separate from the core migration
 *   runner's `step:` namespace — so applying or rolling back plugin migrations
 *   never perturbs core migration bookkeeping.
 *
 * The store resolves its Drizzle handle lazily, per call, through a provider
 * thunk — so constructing the facet never opens the database (tests can build a
 * host without a DB), and each operation runs against the live singleton.
 * {@link buildStoreFacet} passes `getDb`; tests pass a thunk over an in-memory
 * handle.
 */

import type {
  StoreFacet,
  StoreMigration,
} from "@vellumai/skill-host-contracts";

import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { ensureCheckpointsTable } from "../migrations/run-migrations.js";
import { assertScopedToPlugin, pluginTablePrefix } from "./table-namespace.js";

const log = getLogger("plugin-store");

/**
 * Prefix under which plugin migration completions are recorded in the shared
 * `memory_checkpoints` ledger. Distinct from the core runner's `step:`
 * namespace so the two checkpoint sets never collide. Keyed further by host id
 * and migration name: `plugin-step:<hostId>:<name>`.
 */
export const PLUGIN_STEP_CHECKPOINT_PREFIX = "plugin-step:";

/** Build the ledger key for one plugin migration. */
export function pluginStepCheckpointKey(hostId: string, name: string): string {
  return `${PLUGIN_STEP_CHECKPOINT_PREFIX}${hostId}:${name}`;
}

/**
 * Apply a plugin's declared migrations idempotently, in order, each at most
 * once per database. Completion is checkpointed under the plugin-scoped
 * namespace; an already-applied migration is skipped on later boots.
 *
 * Throws on a missing/duplicate migration name (the checkpoint key would be
 * unstable or collide) and on a migration body that touches a table outside the
 * plugin's namespace. A migration body that throws aborts the run — its
 * checkpoint is not written, so it retries next boot.
 */
function runPluginMigrations(
  database: DrizzleDb,
  hostId: string,
  migrations: StoreMigration[],
): void {
  const raw = getSqliteFrom(database);
  ensureCheckpointsTable(raw);

  const seen = new Set<string>();
  for (const migration of migrations) {
    if (!migration.name) {
      throw new Error(
        `plugin "${hostId}" declared a store migration with an empty name`,
      );
    }
    if (seen.has(migration.name)) {
      throw new Error(
        `plugin "${hostId}" declared duplicate store migration "${migration.name}"`,
      );
    }
    seen.add(migration.name);
  }

  const applied = new Set(
    (
      raw
        .query(
          `SELECT key FROM memory_checkpoints WHERE key LIKE ? AND value = '1'`,
        )
        .all(`${PLUGIN_STEP_CHECKPOINT_PREFIX}${hostId}:%`) as Array<{
        key: string;
      }>
    ).map((row) => row.key),
  );

  const markApplied = raw.query(
    `INSERT OR REPLACE INTO memory_checkpoints (key, value, updated_at) VALUES (?, '1', ?)`,
  );

  // Every DDL statement a migration runs is validated against the plugin's
  // prefix before it reaches SQLite, so a migration cannot provision a table
  // outside its namespace.
  const migrationExec = (sql: string, params?: unknown[]): void => {
    assertScopedToPlugin(hostId, sql);
    raw.query(sql).run(...((params ?? []) as never[]));
  };

  for (const migration of migrations) {
    const key = pluginStepCheckpointKey(hostId, migration.name);
    if (applied.has(key)) continue;
    migration.up(migrationExec);
    markApplied.run(key, Date.now());
    log.info(
      { hostId, migration: migration.name },
      "Applied plugin store migration",
    );
  }
}

/**
 * A {@link StoreFacet} bound to one host id, resolving its Drizzle handle lazily
 * through `getDatabase` on each call so construction never opens the DB.
 * Exposed for tests that inject an in-memory handle; production callers use
 * {@link buildStoreFacet}.
 */
export function createStoreFacet(
  getDatabase: () => DrizzleDb,
  hostId: string,
): StoreFacet {
  return {
    qualify: (name: string): string => `${pluginTablePrefix(hostId)}${name}`,
    migrate: (migrations) =>
      runPluginMigrations(getDatabase(), hostId, migrations),
    query: <T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): T[] => {
      assertScopedToPlugin(hostId, sql);
      return getSqliteFrom(getDatabase())
        .query(sql)
        .all(...((params ?? []) as never[])) as T[];
    },
    exec: (sql: string, params?: unknown[]): void => {
      assertScopedToPlugin(hostId, sql);
      getSqliteFrom(getDatabase())
        .query(sql)
        .run(...((params ?? []) as never[]));
    },
  };
}

/**
 * Plugin-owned durable structured store (PR 25).
 *
 * Verifies the three guarantees the facet must hold:
 *
 * 1. A plugin provisions and migrates its own `plugin_<id>_`-prefixed tables
 *    idempotently — re-running `migrate()` is a no-op, recorded under the
 *    plugin-scoped `plugin-step:<hostId>:<name>` checkpoint namespace.
 * 2. Cross-namespace access is rejected: a plugin cannot read or write another
 *    plugin's tables or the core schema through the facet.
 * 3. The core migration ledger's `step:` namespace is untouched by the plugin
 *    runner.
 *
 * Runs against an in-memory Drizzle handle injected through the facet's
 * lazy db-provider thunk — no real workspace DB is opened.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { type DrizzleDb, getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema/index.js";
import {
  createStoreFacet,
  PLUGIN_STEP_CHECKPOINT_PREFIX,
  pluginStepCheckpointKey,
} from "../store.js";
import { PluginStoreNamespaceError } from "../table-namespace.js";

function makeDb(): DrizzleDb {
  const sqlite = new Database(":memory:");
  return drizzle(sqlite, { schema });
}

describe("plugin store facet", () => {
  let db: DrizzleDb;
  beforeEach(() => {
    db = makeDb();
  });

  const acmeMigrations = [
    {
      name: "001-create-notes",
      up: (exec: (sql: string, params?: unknown[]) => void) =>
        exec(
          `CREATE TABLE IF NOT EXISTS plugin_acme_notes (
             id TEXT PRIMARY KEY,
             body TEXT NOT NULL
           )`,
        ),
    },
  ];

  test("provisions and migrates its own tables, checkpointed under the plugin namespace", () => {
    const facet = createStoreFacet(() => db, "acme");
    facet.migrate(acmeMigrations);

    facet.exec(`INSERT INTO plugin_acme_notes (id, body) VALUES (?, ?)`, [
      "n1",
      "hello",
    ]);
    const rows = facet.query<{ id: string; body: string }>(
      `SELECT id, body FROM plugin_acme_notes`,
    );
    expect(rows).toEqual([{ id: "n1", body: "hello" }]);

    // Checkpoint recorded under the plugin-scoped namespace.
    const raw = getSqliteFrom(db);
    const key = pluginStepCheckpointKey("acme", "001-create-notes");
    const ckpt = raw
      .query(`SELECT value FROM memory_checkpoints WHERE key = ?`)
      .get(key) as { value: string } | null;
    expect(ckpt?.value).toBe("1");
    expect(key.startsWith(PLUGIN_STEP_CHECKPOINT_PREFIX)).toBe(true);
  });

  test("re-running migrate() is an idempotent no-op", () => {
    let upCalls = 0;
    const migrations = [
      {
        name: "001-create-notes",
        up: (exec: (sql: string, params?: unknown[]) => void) => {
          upCalls += 1;
          exec(
            `CREATE TABLE IF NOT EXISTS plugin_acme_notes (id TEXT PRIMARY KEY)`,
          );
        },
      },
    ];
    const facet = createStoreFacet(() => db, "acme");

    facet.migrate(migrations);
    facet.migrate(migrations);
    facet.migrate(migrations);

    expect(upCalls).toBe(1);
  });

  test("a later migration appended to the list runs once on a re-migrate", () => {
    const facet = createStoreFacet(() => db, "acme");
    facet.migrate(acmeMigrations);

    let secondRan = 0;
    const extended = [
      ...acmeMigrations,
      {
        name: "002-add-index",
        up: (exec: (sql: string, params?: unknown[]) => void) => {
          secondRan += 1;
          exec(
            `CREATE INDEX IF NOT EXISTS plugin_acme_notes_body ON plugin_acme_notes (body)`,
          );
        },
      },
    ];
    facet.migrate(extended);
    facet.migrate(extended);
    expect(secondRan).toBe(1);
  });

  test("rejects a duplicate migration name", () => {
    const facet = createStoreFacet(() => db, "acme");
    expect(() =>
      facet.migrate([
        { name: "dup", up: () => {} },
        { name: "dup", up: () => {} },
      ]),
    ).toThrow(/duplicate store migration "dup"/);
  });

  test("rejects an empty migration name", () => {
    const facet = createStoreFacet(() => db, "acme");
    expect(() => facet.migrate([{ name: "", up: () => {} }])).toThrow(
      /empty name/,
    );
  });

  describe("namespace isolation", () => {
    beforeEach(() => {
      // Provision acme's table plus a foreign plugin's table and a core table
      // directly (bypassing the facet) so the cross-namespace reads have a real
      // target to be rejected against.
      const raw = getSqliteFrom(db);
      raw.run(`CREATE TABLE plugin_acme_notes (id TEXT PRIMARY KEY)`);
      raw.run(`CREATE TABLE plugin_other_secrets (id TEXT PRIMARY KEY)`);
      raw.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT)`);
      raw.run(`INSERT INTO plugin_other_secrets (id) VALUES ('s1')`);
      raw.run(`INSERT INTO messages (id, content) VALUES ('m1', 'secret')`);
    });

    test("cannot read another plugin's tables", () => {
      const facet = createStoreFacet(() => db, "acme");
      expect(() => facet.query(`SELECT * FROM plugin_other_secrets`)).toThrow(
        PluginStoreNamespaceError,
      );
    });

    test("cannot write another plugin's tables", () => {
      const facet = createStoreFacet(() => db, "acme");
      expect(() =>
        facet.exec(`INSERT INTO plugin_other_secrets (id) VALUES ('x')`),
      ).toThrow(PluginStoreNamespaceError);
    });

    test("cannot read a core table", () => {
      const facet = createStoreFacet(() => db, "acme");
      expect(() => facet.query(`SELECT * FROM messages`)).toThrow(
        PluginStoreNamespaceError,
      );
    });

    test("cannot reach a core table through a JOIN", () => {
      const facet = createStoreFacet(() => db, "acme");
      expect(() =>
        facet.query(
          `SELECT n.id FROM plugin_acme_notes n JOIN messages m ON m.id = n.id`,
        ),
      ).toThrow(PluginStoreNamespaceError);
    });

    test("a migration cannot create a table outside its namespace", () => {
      const facet = createStoreFacet(() => db, "acme");
      expect(() =>
        facet.migrate([
          {
            name: "001-escape",
            up: (exec) =>
              exec(`CREATE TABLE plugin_other_escape (id TEXT PRIMARY KEY)`),
          },
        ]),
      ).toThrow(PluginStoreNamespaceError);
    });

    test("can still read and write its own tables", () => {
      const facet = createStoreFacet(() => db, "acme");
      facet.exec(`INSERT INTO plugin_acme_notes (id) VALUES ('a1')`);
      expect(facet.query(`SELECT id FROM plugin_acme_notes`)).toEqual([
        { id: "a1" },
      ]);
    });
  });

  test("leaves the core `step:` checkpoint namespace untouched", () => {
    const raw = getSqliteFrom(db);
    // Seed a core-runner checkpoint as a prior boot's migration runner would.
    raw.run(`
      CREATE TABLE IF NOT EXISTS memory_checkpoints (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    raw.run(
      `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES ('step:migrateCoreThing', '1', 1)`,
    );

    const facet = createStoreFacet(() => db, "acme");
    facet.migrate(acmeMigrations);

    // Core checkpoint survives untouched; no `step:`-namespaced row was added.
    const stepRows = raw
      .query(
        `SELECT key FROM memory_checkpoints WHERE key LIKE 'step:%' ORDER BY key`,
      )
      .all() as Array<{ key: string }>;
    expect(stepRows.map((r) => r.key)).toEqual(["step:migrateCoreThing"]);

    // The plugin's checkpoint lives in its own namespace.
    const pluginRows = raw
      .query(
        `SELECT key FROM memory_checkpoints WHERE key LIKE '${PLUGIN_STEP_CHECKPOINT_PREFIX}%'`,
      )
      .all() as Array<{ key: string }>;
    expect(pluginRows).toEqual([
      { key: pluginStepCheckpointKey("acme", "001-create-notes") },
    ]);
  });
});

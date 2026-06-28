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
import {
  PluginStoreNamespaceError,
  pluginTablePrefix,
} from "../table-namespace.js";

function makeDb(): DrizzleDb {
  const sqlite = new Database(":memory:");
  return drizzle(sqlite, { schema });
}

describe("plugin store facet", () => {
  let db: DrizzleDb;
  beforeEach(() => {
    db = makeDb();
  });

  // The acme plugin's own fact table, named via the real (hashed) prefix so the
  // guard accepts it. Derived rather than hardcoded because the prefix folds in
  // a digest of the host id — a bare `plugin_acme_notes` no longer matches.
  const ACME_NOTES = `${pluginTablePrefix("acme")}notes`;

  const acmeMigrations = [
    {
      name: "001-create-notes",
      up: (exec: (sql: string, params?: unknown[]) => void) =>
        exec(
          `CREATE TABLE IF NOT EXISTS ${ACME_NOTES} (
             id TEXT PRIMARY KEY,
             body TEXT NOT NULL
           )`,
        ),
    },
  ];

  test("provisions and migrates its own tables, checkpointed under the plugin namespace", () => {
    const facet = createStoreFacet(() => db, "acme");
    facet.migrate(acmeMigrations);

    facet.exec(`INSERT INTO ${ACME_NOTES} (id, body) VALUES (?, ?)`, [
      "n1",
      "hello",
    ]);
    const rows = facet.query<{ id: string; body: string }>(
      `SELECT id, body FROM ${ACME_NOTES}`,
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
            `CREATE TABLE IF NOT EXISTS ${ACME_NOTES} (id TEXT PRIMARY KEY)`,
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
            `CREATE INDEX IF NOT EXISTS ${ACME_NOTES}_body ON ${ACME_NOTES} (body)`,
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
      raw.run(`CREATE TABLE ${ACME_NOTES} (id TEXT PRIMARY KEY)`);
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
          `SELECT n.id FROM ${ACME_NOTES} n JOIN messages m ON m.id = n.id`,
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

    test("cannot CREATE INDEX on a core table", () => {
      // `CREATE INDEX … ON messages` names its target table after `ON`, a
      // position the keyword walk does not key off — the guard must capture and
      // reject it so a plugin migration cannot index/mutate the core schema.
      const facet = createStoreFacet(() => db, "acme");
      expect(() => facet.exec(`CREATE INDEX bad_idx ON messages (id)`)).toThrow(
        PluginStoreNamespaceError,
      );
    });

    test("cannot CREATE INDEX on a foreign plugin table", () => {
      const facet = createStoreFacet(() => db, "acme");
      expect(() =>
        facet.exec(`CREATE INDEX bad_idx ON plugin_other_secrets (id)`),
      ).toThrow(PluginStoreNamespaceError);
    });

    test("cannot CREATE UNIQUE INDEX IF NOT EXISTS on a core table", () => {
      const facet = createStoreFacet(() => db, "acme");
      expect(() =>
        facet.exec(
          `CREATE UNIQUE INDEX IF NOT EXISTS bad_idx ON messages (id)`,
        ),
      ).toThrow(PluginStoreNamespaceError);
    });

    test("can CREATE INDEX on its own table", () => {
      const facet = createStoreFacet(() => db, "acme");
      facet.exec(`CREATE INDEX ${ACME_NOTES}_id_idx ON ${ACME_NOTES} (id)`);
    });

    test("rejects a table-operating statement whose shape captures no table", () => {
      // `ALTER TABLE … RENAME` reaches a table but the guard does not parse its
      // shape into a captured table — fail-closed rejects it rather than letting
      // an unhandled DDL form bypass the namespace check.
      const facet = createStoreFacet(() => db, "acme");
      expect(() =>
        facet.exec(`ALTER TABLE RENAME TO plugin_acme_renamed`),
      ).toThrow(PluginStoreNamespaceError);
    });

    test("allows a table-less SELECT (reaches no table)", () => {
      // `SELECT 1` operates on no table, so it cannot reach another plugin's
      // rows — it must pass rather than be swept up by the fail-closed rule.
      const facet = createStoreFacet(() => db, "acme");
      expect(facet.query<{ one: number }>(`SELECT 1 AS one`)).toEqual([
        { one: 1 },
      ]);
    });

    test("allows a table-less PRAGMA", () => {
      const facet = createStoreFacet(() => db, "acme");
      // user_version is a connection pragma touching no table; must not reject.
      facet.exec(`PRAGMA user_version = 1`);
    });

    test("can still read and write its own tables", () => {
      const facet = createStoreFacet(() => db, "acme");
      facet.exec(`INSERT INTO ${ACME_NOTES} (id) VALUES ('a1')`);
      expect(facet.query(`SELECT id FROM ${ACME_NOTES}`)).toEqual([
        { id: "a1" },
      ]);
    });
  });

  // A plugin must not slip a cross-namespace table past the guard by QUOTING
  // its name. A quoted identifier (`"messages"`, `` `messages` ``, `[messages]`)
  // names the same table as the bare form, so every quote style and statement
  // shape that reaches a foreign/core table must be rejected — while a
  // single-quoted string LITERAL (a value, never a table) stays allowed.
  describe("quoted-identifier namespace bypass", () => {
    beforeEach(() => {
      const raw = getSqliteFrom(db);
      raw.run(`CREATE TABLE ${ACME_NOTES} (id TEXT PRIMARY KEY, body TEXT)`);
      raw.run(`CREATE TABLE plugin_other_secrets (id TEXT PRIMARY KEY)`);
      raw.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT)`);
      raw.run(`INSERT INTO messages (id, content) VALUES ('m1', 'secret')`);
    });

    const quoteStyles: Array<{
      label: string;
      quote: (name: string) => string;
    }> = [
      { label: "double-quote", quote: (n) => `"${n}"` },
      { label: "backtick", quote: (n) => `\`${n}\`` },
      { label: "bracket", quote: (n) => `[${n}]` },
    ];

    for (const { label, quote } of quoteStyles) {
      const core = quote("messages");
      const foreign = quote("plugin_other_secrets");

      test(`${label}: SELECT FROM a core table is rejected`, () => {
        const facet = createStoreFacet(() => db, "acme");
        expect(() => facet.query(`SELECT * FROM ${core}`)).toThrow(
          PluginStoreNamespaceError,
        );
      });

      test(`${label}: SELECT FROM a foreign plugin table is rejected`, () => {
        const facet = createStoreFacet(() => db, "acme");
        expect(() => facet.query(`SELECT * FROM ${foreign}`)).toThrow(
          PluginStoreNamespaceError,
        );
      });

      test(`${label}: INSERT INTO a core table is rejected`, () => {
        const facet = createStoreFacet(() => db, "acme");
        expect(() =>
          facet.exec(`INSERT INTO ${core} (id, content) VALUES ('x', 'y')`),
        ).toThrow(PluginStoreNamespaceError);
      });

      test(`${label}: UPDATE a core table is rejected`, () => {
        const facet = createStoreFacet(() => db, "acme");
        expect(() =>
          facet.exec(`UPDATE ${core} SET content = 'pwned'`),
        ).toThrow(PluginStoreNamespaceError);
      });

      test(`${label}: DELETE FROM a core table is rejected`, () => {
        const facet = createStoreFacet(() => db, "acme");
        expect(() => facet.exec(`DELETE FROM ${core}`)).toThrow(
          PluginStoreNamespaceError,
        );
      });

      test(`${label}: JOIN onto a core table is rejected`, () => {
        const facet = createStoreFacet(() => db, "acme");
        expect(() =>
          facet.query(
            `SELECT n.id FROM ${ACME_NOTES} n JOIN ${core} m ON m.id = n.id`,
          ),
        ).toThrow(PluginStoreNamespaceError);
      });

      test(`${label}: a multi-table FROM-list comma reaching a core table is rejected`, () => {
        const facet = createStoreFacet(() => db, "acme");
        expect(() =>
          facet.query(`SELECT * FROM ${ACME_NOTES}, ${core}`),
        ).toThrow(PluginStoreNamespaceError);
      });

      test(`${label}: own quoted table is allowed`, () => {
        const facet = createStoreFacet(() => db, "acme");
        const own = quote(ACME_NOTES);
        facet.exec(`INSERT INTO ${own} (id, body) VALUES ('q1', 'ok')`);
        expect(facet.query<{ id: string }>(`SELECT id FROM ${own}`)).toEqual([
          { id: "q1" },
        ]);
      });

      test(`${label}: CREATE INDEX ON a quoted core table is rejected`, () => {
        // The `ON <table>` target may itself be quoted — the guard recovers the
        // inner name and rejects it just like the bare form.
        const facet = createStoreFacet(() => db, "acme");
        expect(() => facet.exec(`CREATE INDEX idx ON ${core} (id)`)).toThrow(
          PluginStoreNamespaceError,
        );
      });

      test(`${label}: CREATE INDEX ON the own quoted table is allowed`, () => {
        const facet = createStoreFacet(() => db, "acme");
        const own = quote(ACME_NOTES);
        const indexName = `idx_${label.replace(/[^a-z0-9]+/g, "_")}`;
        facet.exec(`CREATE INDEX ${indexName} ON ${own} (id)`);
      });
    }

    test("a schema-qualified quoted table name is still rejected", () => {
      // `main."messages"` lexes as a trailing-dot bareword + a quoted token;
      // the quoted segment is the real table and must be validated, not slipped
      // past the guard as the bareword's empty final segment.
      const facet = createStoreFacet(() => db, "acme");
      expect(() => facet.query(`SELECT * FROM main."messages"`)).toThrow(
        PluginStoreNamespaceError,
      );
      // The own-prefixed equivalent is allowed.
      facet.query(`SELECT * FROM main."${ACME_NOTES}"`);
    });

    test("a single-quoted string literal value is not treated as a table", () => {
      // GIVEN a string literal that spells a foreign/core table name
      // WHEN it appears as a VALUE (single quotes) on the plugin's own table
      // THEN the statement is allowed — only the table reference is namespaced.
      const facet = createStoreFacet(() => db, "acme");
      facet.exec(
        `INSERT INTO ${ACME_NOTES} (id, body) VALUES ('n1', 'messages')`,
      );
      expect(
        facet.query<{ body: string }>(
          `SELECT body FROM ${ACME_NOTES} WHERE body = 'plugin_other_secrets'`,
        ),
      ).toEqual([]);
      expect(
        facet.query<{ body: string }>(`SELECT body FROM ${ACME_NOTES}`),
      ).toEqual([{ body: "messages" }]);
    });

    test("a quoted column on the plugin's own table does not false-reject", () => {
      // A quoted IDENTIFIER that is a column (not after a table keyword) must
      // not be mistaken for a table reference.
      const facet = createStoreFacet(() => db, "acme");
      facet.exec(`INSERT INTO ${ACME_NOTES} (id, body) VALUES ('c1', 'v')`);
      expect(
        facet.query<{ id: string }>(
          `SELECT "id" FROM ${ACME_NOTES} WHERE "body" = 'v'`,
        ),
      ).toEqual([{ id: "c1" }]);
    });
  });

  // Sanitizing a host id to the SQL-identifier alphabet is lossy: `foo-bar`,
  // `foo_bar`, and `foo.bar` all reduce to `foo_bar`. If the table prefix were
  // sanitize-only, those three distinct plugins would share a prefix — and since
  // the namespace guard authorizes solely by prefix, they could read and write
  // each other's tables. The prefix folds in a digest of the RAW id to stay
  // injective; these tests pin that distinct raw ids get distinct, isolated
  // prefixes even when their sanitized forms collide.
  describe("injective prefix across sanitize-colliding host ids", () => {
    const collidingIds = ["foo-bar", "foo_bar", "foo.bar"];

    test("distinct raw ids yield distinct table prefixes", () => {
      const prefixes = collidingIds.map((id) => pluginTablePrefix(id));
      // All three sanitize to the same middle segment, so a sanitize-only prefix
      // would make these identical; the hash makes them pairwise distinct.
      expect(new Set(prefixes).size).toBe(collidingIds.length);
      // Each prefix is still a bare (unquoted-safe) SQL identifier fragment.
      for (const prefix of prefixes) {
        expect(prefix).toMatch(/^plugin_[a-z0-9_]+_$/);
      }
    });

    test("the prefix is stable for a given raw id", () => {
      expect(pluginTablePrefix("foo-bar")).toBe(pluginTablePrefix("foo-bar"));
    });

    test("colliding-name plugins cannot access each other's tables", () => {
      const raw = getSqliteFrom(db);
      // Provision each plugin's own table under its real (hashed) prefix.
      const tableFor = (id: string) => `${pluginTablePrefix(id)}notes`;
      for (const id of collidingIds) {
        raw.run(`CREATE TABLE ${tableFor(id)} (id TEXT PRIMARY KEY)`);
        raw.run(`INSERT INTO ${tableFor(id)} (id) VALUES ('${id}')`);
      }

      const [a, b, c] = collidingIds;
      const facetA = createStoreFacet(() => db, a!);

      // A can read its own table.
      expect(facetA.query(`SELECT id FROM ${tableFor(a!)}`)).toEqual([
        { id: a },
      ]);
      // But not B's or C's, even though all three sanitize alike.
      expect(() => facetA.query(`SELECT id FROM ${tableFor(b!)}`)).toThrow(
        PluginStoreNamespaceError,
      );
      expect(() =>
        facetA.exec(`INSERT INTO ${tableFor(c!)} (id) VALUES ('x')`),
      ).toThrow(PluginStoreNamespaceError);
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

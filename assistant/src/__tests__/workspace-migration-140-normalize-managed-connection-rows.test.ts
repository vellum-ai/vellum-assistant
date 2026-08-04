import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { normalizeManagedConnectionRowsMigration } from "../workspace/migrations/140-normalize-managed-connection-rows.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import { assertNotLiveDb } from "./assert-not-live-db.js";

let workspaceDir: string;

function dbPath(): string {
  return join(workspaceDir, "data", "db", "assistant.db");
}

function createDb(): Database {
  mkdirSync(join(workspaceDir, "data", "db"), { recursive: true });
  const db = new Database(dbPath());
  db.run(`CREATE TABLE provider_connections (
    name TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    auth TEXT NOT NULL,
    label TEXT,
    base_url TEXT,
    models TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  return db;
}

function insertRow(
  db: Database,
  name: string,
  provider: string,
  auth: string,
): void {
  db.query(
    `INSERT INTO provider_connections (name, provider, auth, created_at, updated_at) VALUES (?, ?, ?, 1, 1)`,
  ).run(name, provider, auth);
}

function readRows(): Array<{ name: string; provider: string; auth: string }> {
  const db = new Database(dbPath());
  try {
    return db
      .query(
        `SELECT name, provider, auth FROM provider_connections ORDER BY name`,
      )
      .all() as Array<{ name: string; provider: string; auth: string }>;
  } finally {
    db.close();
  }
}

function readRow(name: string): { provider: string; auth: string } {
  const row = readRows().find((r) => r.name === name);
  if (!row) {
    throw new Error(`row "${name}" not found`);
  }
  return row;
}

function run(): void {
  normalizeManagedConnectionRowsMigration.run(workspaceDir);
}

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-140-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    assertNotLiveDb(workspaceDir);
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("140-normalize-managed-connection-rows", () => {
  test("has correct migration id and is registered last", () => {
    expect(normalizeManagedConnectionRowsMigration.id).toBe(
      "140-normalize-managed-connection-rows",
    );
    // getLastWorkspaceMigrationId() reports the final entry as the registry
    // ceiling, so the highest id must stay last.
    expect(WORKSPACE_MIGRATIONS[WORKSPACE_MIGRATIONS.length - 1]?.id).toBe(
      "140-normalize-managed-connection-rows",
    );
  });

  test("rewrites a platform-auth row with a concrete provider to provider vellum", () => {
    const db = createDb();
    insertRow(db, "managed-openai", "openai", '{"type":"platform"}');
    db.close();

    run();

    const row = readRow("managed-openai");
    expect(row.provider).toBe("vellum");
    expect(JSON.parse(row.auth)).toEqual({ type: "platform" });
  });

  test("heals a stuck legacy canonical row (name vellum, concrete provider, platform auth)", () => {
    const db = createDb();
    insertRow(db, "vellum", "anthropic", '{"type":"platform"}');
    db.close();

    run();

    expect(readRow("vellum").provider).toBe("vellum");
  });

  test("rewrites a vellum-provider row with non-platform auth to platform auth", () => {
    const db = createDb();
    insertRow(
      db,
      "keyed-vellum",
      "vellum",
      '{"type":"api_key","credential":"vault/x"}',
    );
    insertRow(db, "none-vellum", "vellum", '{"type":"none"}');
    db.close();

    run();

    expect(JSON.parse(readRow("keyed-vellum").auth)).toEqual({
      type: "platform",
    });
    expect(JSON.parse(readRow("none-vellum").auth)).toEqual({
      type: "platform",
    });
  });

  test("leaves consistent rows untouched", () => {
    const db = createDb();
    insertRow(db, "vellum", "vellum", '{"type":"platform"}');
    insertRow(
      db,
      "anthropic-key",
      "anthropic",
      '{"type":"api_key","credential":"vault/anthropic"}',
    );
    insertRow(
      db,
      "chatgpt-subscription",
      "openai",
      '{"type":"oauth_subscription"}',
    );
    insertRow(db, "ollama-local", "ollama", '{"type":"none"}');
    db.close();

    const before = readRows();
    run();

    expect(readRows()).toEqual(before);
  });

  test("leaves a BYOK row claiming the canonical name untouched", () => {
    const db = createDb();
    insertRow(
      db,
      "vellum",
      "anthropic",
      '{"type":"api_key","credential":"vault/anthropic"}',
    );
    db.close();

    run();

    const row = readRow("vellum");
    expect(row.provider).toBe("anthropic");
    expect(JSON.parse(row.auth).type).toBe("api_key");
  });

  test("leaves a row with unparseable auth untouched", () => {
    const db = createDb();
    insertRow(db, "broken", "vellum", "not json");
    db.close();

    run();

    expect(readRow("broken").auth).toBe("not json");
  });

  test("is idempotent", () => {
    const db = createDb();
    insertRow(db, "managed-openai", "openai", '{"type":"platform"}');
    insertRow(db, "keyed-vellum", "vellum", '{"type":"api_key"}');
    db.close();

    run();
    const afterFirst = readRows();
    run();

    expect(readRows()).toEqual(afterFirst);
  });

  test("no-ops when the DB or table does not exist", () => {
    expect(() => run()).not.toThrow();

    mkdirSync(join(workspaceDir, "data", "db"), { recursive: true });
    new Database(dbPath()).close(); // empty DB, no table
    expect(() => run()).not.toThrow();
  });
});

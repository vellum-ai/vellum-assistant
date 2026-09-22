import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../../schema.js";
import { migrateNormalizeOpencodeHostConnections } from "../383-normalize-opencode-host-connections.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(/*sql*/ `
    CREATE TABLE provider_connections (
      name        TEXT PRIMARY KEY,
      provider    TEXT NOT NULL,
      auth        TEXT NOT NULL,
      label       TEXT,
      base_url    TEXT,
      models      TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function insertRow(
  sqlite: Database,
  name: string,
  provider: string,
  baseUrl: string | null,
): void {
  sqlite
    .query(
      /*sql*/ `INSERT INTO provider_connections (name, provider, auth, base_url, created_at, updated_at)
       VALUES (?, ?, '{"type":"api_key","credential":"cred"}', ?, 1, 1)`,
    )
    .run(name, provider, baseUrl);
}

function readProvider(sqlite: Database, name: string): string | undefined {
  const row = sqlite
    .query(`SELECT provider FROM provider_connections WHERE name = ?`)
    .get(name) as { provider: string } | null;
  return row?.provider;
}

describe("migration 383: normalize opencode-host connections", () => {
  test("restamps openai-compatible rows pointed at opencode.ai", () => {
    const { sqlite, db } = createTestDb();
    insertRow(
      sqlite,
      "go",
      "openai-compatible",
      "https://opencode.ai/zen/go/v1",
    );
    insertRow(sqlite, "zen", "openai-compatible", "https://opencode.ai/zen/v1");
    insertRow(sqlite, "sub", "openai-compatible", "https://api.opencode.ai/v1");
    insertRow(sqlite, "vllm", "openai-compatible", "http://localhost:8080/v1");
    insertRow(
      sqlite,
      "lookalike",
      "openai-compatible",
      "https://opencode.ai.evil.example/v1",
    );
    insertRow(sqlite, "ollama", "ollama", "https://opencode.ai/v1");

    migrateNormalizeOpencodeHostConnections(db);

    expect(readProvider(sqlite, "go")).toBe("opencode");
    expect(readProvider(sqlite, "zen")).toBe("opencode");
    expect(readProvider(sqlite, "sub")).toBe("opencode");
    expect(readProvider(sqlite, "vllm")).toBe("openai-compatible");
    expect(readProvider(sqlite, "lookalike")).toBe("openai-compatible");
    expect(readProvider(sqlite, "ollama")).toBe("ollama");
  });

  test("is idempotent and tolerates a missing table", () => {
    const { sqlite, db } = createTestDb();
    insertRow(
      sqlite,
      "go",
      "openai-compatible",
      "https://opencode.ai/zen/go/v1",
    );
    migrateNormalizeOpencodeHostConnections(db);
    migrateNormalizeOpencodeHostConnections(db);
    expect(readProvider(sqlite, "go")).toBe("opencode");

    const bare = drizzle(new Database(":memory:"), { schema });
    expect(() => migrateNormalizeOpencodeHostConnections(bare)).not.toThrow();
  });
});

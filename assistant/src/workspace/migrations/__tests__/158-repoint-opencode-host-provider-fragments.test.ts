import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { WORKSPACE_MIGRATIONS } from "../registry.js";

const migration = WORKSPACE_MIGRATIONS.find(
  (entry) => entry.id === "158-repoint-opencode-host-provider-fragments",
)!;

const workspaces: string[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function setup(): string {
  const workspace = mkdtempSync(join(tmpdir(), "opencode-repoint-migration-"));
  workspaces.push(workspace);
  return workspace;
}

function writeConfig(workspace: string, data: Record<string, unknown>): void {
  writeFileSync(
    join(workspace, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readLlm(workspace: string): Record<string, any> {
  return JSON.parse(readFileSync(join(workspace, "config.json"), "utf-8")).llm;
}

function seedRows(
  workspace: string,
  rows: Array<{ name: string; provider: string; baseUrl: string | null }>,
): void {
  mkdirSync(join(workspace, "data", "db"), { recursive: true });
  const db = new Database(join(workspace, "data", "db", "assistant.db"));
  db.run(`CREATE TABLE provider_connections (
    name TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    auth TEXT NOT NULL,
    base_url TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  for (const row of rows) {
    db.query(
      `INSERT INTO provider_connections (name, provider, auth, base_url, created_at, updated_at)
       VALUES (?, ?, '{"type":"api_key","credential":"cred"}', ?, 1, 1)`,
    ).run(row.name, row.provider, row.baseUrl);
  }
  db.close();
}

describe("migration 158: repoint opencode-host provider fragments", () => {
  test("repoints legacy-shape fragments bound to an opencode.ai row, whichever provider the row stores", () => {
    const workspace = setup();
    seedRows(workspace, [
      {
        name: "go",
        provider: "openai-compatible",
        baseUrl: "https://opencode.ai/zen/go/v1",
      },
      {
        name: "zen",
        provider: "opencode",
        baseUrl: "https://opencode.ai/zen/v1",
      },
      {
        name: "vllm",
        provider: "openai-compatible",
        baseUrl: "http://localhost:8080/v1",
      },
    ]);
    writeConfig(workspace, {
      llm: {
        default: {
          provider: "openai-compatible",
          provider_connection: "go",
          model: "m",
        },
        profiles: {
          a: {
            provider: "openai-compatible",
            provider_connection: "go",
            model: "m",
          },
          b: {
            provider: "openai-compatible",
            provider_connection: "zen",
            model: "m",
          },
          c: {
            provider: "openai-compatible",
            provider_connection: "vllm",
            model: "m",
          },
          entry: { provider: "go", model: "m" },
          unbound: { provider: "openai-compatible", model: "m" },
          dangling: {
            provider: "openai-compatible",
            provider_connection: "gone",
            model: "m",
          },
        },
      },
    });

    migration.run(workspace);

    const llm = readLlm(workspace);
    expect(llm.default.provider).toBe("opencode");
    expect(llm.default.provider_connection).toBe("go");
    expect(llm.profiles.a.provider).toBe("opencode");
    expect(llm.profiles.b.provider).toBe("opencode");
    expect(llm.profiles.c.provider).toBe("openai-compatible");
    expect(llm.profiles.entry.provider).toBe("go");
    expect(llm.profiles.unbound.provider).toBe("openai-compatible");
    expect(llm.profiles.dangling.provider).toBe("openai-compatible");
  });

  test("no-ops without config, without a db, or with nothing bound", () => {
    const noConfig = setup();
    expect(() => migration.run(noConfig)).not.toThrow();

    const noDb = setup();
    writeConfig(noDb, {
      llm: {
        profiles: {
          a: { provider: "openai-compatible", provider_connection: "go" },
        },
      },
    });
    migration.run(noDb);
    expect(readLlm(noDb).profiles.a.provider).toBe("openai-compatible");
  });

  test("fails the run instead of checkpointing when the db is unreadable", () => {
    const workspace = setup();
    seedRows(workspace, []);
    writeFileSync(
      join(workspace, "data", "db", "assistant.db"),
      "not a database",
    );
    writeConfig(workspace, {
      llm: {
        profiles: {
          a: { provider: "openai-compatible", provider_connection: "go" },
        },
      },
    });
    expect(() => migration.run(workspace)).toThrow(/not readable/);
  });

  test("is idempotent", () => {
    const workspace = setup();
    seedRows(workspace, [
      {
        name: "go",
        provider: "openai-compatible",
        baseUrl: "https://opencode.ai/zen/go/v1",
      },
    ]);
    writeConfig(workspace, {
      llm: {
        profiles: {
          a: { provider: "openai-compatible", provider_connection: "go" },
        },
      },
    });
    migration.run(workspace);
    const once = readFileSync(join(workspace, "config.json"), "utf-8");
    migration.run(workspace);
    expect(readFileSync(join(workspace, "config.json"), "utf-8")).toBe(once);
    expect(readLlm(workspace).profiles.a.provider).toBe("opencode");
  });
});

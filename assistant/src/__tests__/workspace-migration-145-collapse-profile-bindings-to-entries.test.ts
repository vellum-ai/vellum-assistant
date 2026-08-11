import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { collapseProfileBindingsToEntriesMigration } from "../workspace/migrations/145-collapse-profile-bindings-to-entries.js";
import { assertNotLiveDb } from "./assert-not-live-db.js";

let workspaceDir: string;

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readProfiles(): Record<string, Record<string, unknown>> {
  const raw = JSON.parse(
    readFileSync(join(workspaceDir, "config.json"), "utf-8"),
  ) as { llm?: { profiles?: Record<string, Record<string, unknown>> } };
  return raw.llm?.profiles ?? {};
}

function seedRows(rows: Array<{ name: string; provider: string }>): void {
  mkdirSync(join(workspaceDir, "data", "db"), { recursive: true });
  const db = new Database(join(workspaceDir, "data", "db", "assistant.db"));
  db.run(`CREATE TABLE IF NOT EXISTS provider_connections (
    name TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  for (const row of rows) {
    db.query(
      `INSERT INTO provider_connections (name, provider, auth, created_at, updated_at) VALUES (?, ?, '{"type":"api_key"}', 1, 1)`,
    ).run(row.name, row.provider);
  }
  db.close();
}

function run(): void {
  collapseProfileBindingsToEntriesMigration.run(workspaceDir);
}

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-145-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    assertNotLiveDb(workspaceDir);
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("145-collapse-profile-bindings-to-entries", () => {
  test("folds a kind-agreeing binding into provider as the entry name", () => {
    seedRows([{ name: "anthropic-work", provider: "anthropic" }]);
    writeConfig({
      llm: {
        profiles: {
          work: {
            provider: "anthropic",
            provider_connection: "anthropic-work",
            model: "claude-opus-4-8",
          },
        },
      },
    });

    run();

    const work = readProfiles().work;
    expect(work.provider).toBe("anthropic-work");
    expect(work).not.toHaveProperty("provider_connection");
    expect(work.model).toBe("claude-opus-4-8");
  });

  test("maps identity kinds when judging agreement", () => {
    seedRows([
      { name: "team-managed", provider: "vellum" },
      { name: "chatgpt-subscription", provider: "chatgpt" },
    ]);
    writeConfig({
      llm: {
        profiles: {
          managed: {
            provider: "anthropic",
            provider_connection: "team-managed",
            model: "claude-opus-4-8",
          },
          codex: {
            provider: "openai",
            provider_connection: "chatgpt-subscription",
            model: "gpt-5.5",
          },
        },
      },
    });

    run();

    expect(readProfiles().managed.provider).toBe("team-managed");
    expect(readProfiles().codex.provider).toBe("chatgpt-subscription");
  });

  test("keeps the vendor and drops a dangling binding with a warn", () => {
    seedRows([]);
    writeConfig({
      llm: {
        profiles: {
          stale: {
            provider: "anthropic",
            provider_connection: "deleted-row",
            model: "claude-opus-4-8",
          },
        },
      },
    });

    run();

    const stale = readProfiles().stale;
    expect(stale.provider).toBe("anthropic");
    expect(stale).not.toHaveProperty("provider_connection");
  });

  test("keeps the vendor and drops a kind-disagreeing binding", () => {
    seedRows([{ name: "ollama-local", provider: "ollama" }]);
    writeConfig({
      llm: {
        profiles: {
          conflicted: {
            provider: "anthropic",
            provider_connection: "ollama-local",
            model: "claude-opus-4-8",
          },
        },
      },
    });

    run();

    const conflicted = readProfiles().conflicted;
    expect(conflicted.provider).toBe("anthropic");
    expect(conflicted).not.toHaveProperty("provider_connection");
  });

  test("strips a stray binding from a routing-identity profile", () => {
    seedRows([{ name: "vellum", provider: "vellum" }]);
    writeConfig({
      llm: {
        profiles: {
          managed: {
            provider: "vellum",
            provider_connection: "vellum",
            model: "claude-opus-4-8",
          },
        },
      },
    });

    run();

    const managed = readProfiles().managed;
    expect(managed.provider).toBe("vellum");
    expect(managed).not.toHaveProperty("provider_connection");
  });

  test("deletes a self-referential binding when no row claims that name", () => {
    seedRows([{ name: "anthropic-work", provider: "anthropic" }]);
    writeConfig({
      llm: {
        profiles: {
          plain: {
            provider: "anthropic",
            provider_connection: "anthropic",
            model: "claude-opus-4-8",
          },
        },
      },
    });

    run();

    expect(readProfiles().plain.provider).toBe("anthropic");
    expect(readProfiles().plain).not.toHaveProperty("provider_connection");
  });

  test("an absent DB file means genuinely dangling bindings (restored config)", () => {
    writeConfig({
      llm: {
        profiles: {
          bound: {
            provider: "anthropic",
            provider_connection: "anthropic-work",
            model: "claude-opus-4-8",
          },
        },
      },
    });
    // No DB at all: a config restored into a fresh workspace has no rows.

    run();

    const bound = readProfiles().bound;
    expect(bound.provider).toBe("anthropic");
    expect(bound).not.toHaveProperty("provider_connection");
  });

  test("throws (for retry) when bindings exist but the DB is unqueryable", () => {
    writeConfig({
      llm: {
        profiles: {
          bound: {
            provider: "anthropic",
            provider_connection: "anthropic-work",
            model: "claude-opus-4-8",
          },
        },
      },
    });
    // DB file exists but carries no provider_connections table.
    mkdirSync(join(workspaceDir, "data", "db"), { recursive: true });
    new Database(join(workspaceDir, "data", "db", "assistant.db")).close();

    expect(() => run()).toThrow(/not readable/);
    // Config untouched: no destructive guess was made.
    expect(readProfiles().bound.provider_connection).toBe("anthropic-work");
    expect(
      collapseProfileBindingsToEntriesMigration.retryFailedCheckpoint,
    ).toBe(true);
  });

  test("folds a canonical vellum binding only for identity-servable models", () => {
    seedRows([{ name: "vellum", provider: "vellum" }]);
    writeConfig({
      llm: {
        profiles: {
          routable: {
            provider: "anthropic",
            provider_connection: "vellum",
            model: "claude-opus-4-8",
          },
          stale: {
            provider: "anthropic",
            provider_connection: "vellum",
            model: "claude-ancient-1",
          },
        },
      },
    });

    run();

    const routable = readProfiles().routable;
    expect(routable.provider).toBe("vellum");
    expect(routable).not.toHaveProperty("provider_connection");
    // An unservable model would be stripped by the read-path schema if
    // folded to the identity; the profile stays untouched instead.
    const stale = readProfiles().stale;
    expect(stale.provider).toBe("anthropic");
    expect(stale.provider_connection).toBe("vellum");
  });

  test("keeps a self-named binding when a row by that name exists", () => {
    seedRows([
      { name: "anthropic", provider: "anthropic" },
      { name: "anthropic-2", provider: "anthropic" },
    ]);
    writeConfig({
      llm: {
        profiles: {
          pinned: {
            provider: "anthropic",
            provider_connection: "anthropic",
            model: "claude-opus-4-8",
          },
        },
      },
    });

    run();

    // The explicit pin survives: with sibling rows, the bare vendor would
    // auto-resolve differently.
    expect(readProfiles().pinned.provider_connection).toBe("anthropic");
  });

  test("no-ops without bindings and is idempotent", () => {
    seedRows([{ name: "anthropic-work", provider: "anthropic" }]);
    writeConfig({
      llm: {
        profiles: {
          work: {
            provider: "anthropic",
            provider_connection: "anthropic-work",
            model: "claude-opus-4-8",
          },
          unbound: { provider: "vellum", model: "claude-opus-4-8" },
        },
      },
    });

    run();
    const afterFirst = readProfiles();
    run();

    expect(readProfiles()).toEqual(afterFirst);
    expect(afterFirst.unbound.provider).toBe("vellum");
  });
});

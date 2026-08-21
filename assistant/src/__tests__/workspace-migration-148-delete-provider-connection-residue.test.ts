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

import { deleteProviderConnectionResidueMigration } from "../workspace/migrations/148-delete-provider-connection-residue.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import { assertNotLiveDb } from "./assert-not-live-db.js";

let workspaceDir: string;

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readLlm(): {
  default?: Record<string, unknown>;
  profiles?: Record<string, Record<string, unknown>>;
} {
  const raw = JSON.parse(
    readFileSync(join(workspaceDir, "config.json"), "utf-8"),
  ) as {
    llm?: {
      default?: Record<string, unknown>;
      profiles?: Record<string, Record<string, unknown>>;
    };
  };
  return raw.llm ?? {};
}

function readProfiles(): Record<string, Record<string, unknown>> {
  return readLlm().profiles ?? {};
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
  deleteProviderConnectionResidueMigration.run(workspaceDir);
}

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-148-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    assertNotLiveDb(workspaceDir);
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("148-delete-provider-connection-residue", () => {
  test("is registered last (the registry ceiling reads the final entry)", () => {
    expect(deleteProviderConnectionResidueMigration.id).toBe(
      "148-delete-provider-connection-residue",
    );
    expect(WORKSPACE_MIGRATIONS[WORKSPACE_MIGRATIONS.length - 1]?.id).toBe(
      "148-delete-provider-connection-residue",
    );
  });

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

  test("folds a self-named pin (the entry name is the vendor)", () => {
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

    const pinned = readProfiles().pinned;
    expect(pinned.provider).toBe("anthropic");
    expect(pinned).not.toHaveProperty("provider_connection");
  });

  test("drops a dangling binding with the vendor kept", () => {
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

  test("drops a kind-disagreeing binding with the vendor kept", () => {
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
    // An unservable model cannot fold to the identity (the read-path schema
    // would strip the profile); the field is dropped and the vendor stays.
    const stale = readProfiles().stale;
    expect(stale.provider).toBe("anthropic");
    expect(stale).not.toHaveProperty("provider_connection");
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

  test("sweeps the legacy llm.default blob too", () => {
    seedRows([{ name: "anthropic-work", provider: "anthropic" }]);
    writeConfig({
      llm: {
        default: {
          provider: "anthropic",
          provider_connection: "anthropic-work",
          model: "claude-opus-4-8",
        },
      },
    });

    run();

    const dflt = readLlm().default!;
    expect(dflt.provider).toBe("anthropic-work");
    expect(dflt).not.toHaveProperty("provider_connection");
  });

  test("an absent DB file drops every binding as dangling (restored config)", () => {
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

  test("defers (for retry) when bindings exist but the table is missing", () => {
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
    expect(deleteProviderConnectionResidueMigration.retryFailedCheckpoint).toBe(
      true,
    );
  });

  test("defers when bindings exist but the DB is unreadable", () => {
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
    // A directory where the DB file should be makes the open itself fail.
    mkdirSync(join(workspaceDir, "data", "db", "assistant.db"), {
      recursive: true,
    });

    expect(() => run()).toThrow(/not readable/);
    expect(readProfiles().bound.provider_connection).toBe("anthropic-work");
  });

  test("a config without bindings completes normally regardless of table state", () => {
    writeConfig({
      llm: {
        profiles: {
          unbound: { provider: "anthropic", model: "claude-opus-4-8" },
        },
      },
    });
    // DB file exists but carries no provider_connections table: with
    // nothing to judge, fresh installs must not loop on a failed
    // checkpoint.
    mkdirSync(join(workspaceDir, "data", "db"), { recursive: true });
    new Database(join(workspaceDir, "data", "db", "assistant.db")).close();
    const before = readFileSync(join(workspaceDir, "config.json"), "utf-8");

    expect(() => run()).not.toThrow();
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      before,
    );
  });

  test("no-ops without the field and is idempotent", () => {
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
    const afterFirst = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    run();

    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      afterFirst,
    );
    expect(readProfiles().unbound.provider).toBe("vellum");
    expect(readProfiles().unbound).not.toHaveProperty("provider_connection");
  });
});

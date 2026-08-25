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

import { canonicalizeProfileRouteReferencesMigration } from "../workspace/migrations/147-canonicalize-profile-route-references.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import { assertNotLiveDb } from "./assert-not-live-db.js";

let workspaceDir: string;

function writeConfig(profiles: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify({ llm: { profiles } }, null, 2) + "\n",
  );
}

function readProfiles(): Record<string, Record<string, unknown>> {
  const config = JSON.parse(
    readFileSync(join(workspaceDir, "config.json"), "utf-8"),
  ) as { llm: { profiles: Record<string, Record<string, unknown>> } };
  return config.llm.profiles;
}

function seedRows(rows: Array<{ name: string; provider: string }>): void {
  mkdirSync(join(workspaceDir, "data", "db"), { recursive: true });
  const db = new Database(join(workspaceDir, "data", "db", "assistant.db"));
  db.run(`CREATE TABLE provider_connections (
    name TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  for (const row of rows) {
    db.query(
      `INSERT INTO provider_connections (name, provider, auth, created_at, updated_at)
       VALUES (?, ?, '{"type":"api_key"}', 1, 1)`,
    ).run(row.name, row.provider);
  }
  db.close();
}

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-147-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    assertNotLiveDb(workspaceDir);
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("147-canonicalize-profile-route-references", () => {
  test("is the final registered workspace migration", () => {
    expect(WORKSPACE_MIGRATIONS.at(-1)).toBe(
      canonicalizeProfileRouteReferencesMigration,
    );
  });

  test("preserves a self-named exact pin with an explicit reference", () => {
    seedRows([{ name: "anthropic", provider: "anthropic" }]);
    writeConfig({
      pinned: {
        provider: "anthropic",
        provider_connection: "anthropic",
        model: "claude-opus-4-8",
      },
    });

    canonicalizeProfileRouteReferencesMigration.run(workspaceDir);

    expect(readProfiles().pinned).toEqual({
      provider: "connection:anthropic",
      model: "claude-opus-4-8",
    });
  });

  test("keeps a non-colliding exact entry name readable", () => {
    seedRows([{ name: "anthropic-work", provider: "anthropic" }]);
    writeConfig({
      work: {
        provider: "anthropic",
        provider_connection: "anthropic-work",
        model: "claude-opus-4-8",
      },
    });

    canonicalizeProfileRouteReferencesMigration.run(workspaceDir);

    expect(readProfiles().work).toEqual({
      provider: "anthropic-work",
      model: "claude-opus-4-8",
    });
  });

  test("escapes an entry name that starts with the reference prefix", () => {
    seedRows([{ name: "connection:anthropic", provider: "anthropic" }]);
    writeConfig({
      escaped: {
        provider: "anthropic",
        provider_connection: "connection:anthropic",
        model: "claude-opus-4-8",
      },
    });

    canonicalizeProfileRouteReferencesMigration.run(workspaceDir);

    expect(readProfiles().escaped.provider).toBe(
      "connection:connection%3Aanthropic",
    );
    expect(readProfiles().escaped).not.toHaveProperty("provider_connection");
  });

  test("escapes a prefix entry already folded by migration 145", () => {
    seedRows([{ name: "connection:anthropic", provider: "anthropic" }]);
    writeConfig({
      escaped: {
        provider: "connection:anthropic",
        model: "claude-opus-4-8",
      },
    });

    canonicalizeProfileRouteReferencesMigration.run(workspaceDir);

    expect(readProfiles().escaped.provider).toBe(
      "connection:connection%3Aanthropic",
    );
  });

  test("keeps mismatched, dangling, and identity-sensitive bindings", () => {
    seedRows([
      { name: "ollama-local", provider: "ollama" },
      { name: "vellum", provider: "vellum" },
    ]);
    const profiles = {
      mismatched: {
        provider: "anthropic",
        provider_connection: "ollama-local",
        model: "claude-opus-4-8",
      },
      dangling: {
        provider: "anthropic",
        provider_connection: "deleted-row",
        model: "claude-opus-4-8",
      },
      identitySensitive: {
        provider: "anthropic",
        provider_connection: "vellum",
        model: "custom-model",
      },
    };
    writeConfig(profiles);

    canonicalizeProfileRouteReferencesMigration.run(workspaceDir);

    expect(readProfiles()).toEqual(profiles);
  });

  test("retries instead of guessing when the connection table is unreadable", () => {
    writeConfig({
      pinned: {
        provider: "anthropic",
        provider_connection: "anthropic",
        model: "claude-opus-4-8",
      },
    });
    mkdirSync(join(workspaceDir, "data", "db"), { recursive: true });
    new Database(join(workspaceDir, "data", "db", "assistant.db")).close();

    expect(() =>
      canonicalizeProfileRouteReferencesMigration.run(workspaceDir),
    ).toThrow(/not readable/);
    expect(readProfiles().pinned.provider_connection).toBe("anthropic");
    expect(
      canonicalizeProfileRouteReferencesMigration.retryFailedCheckpoint,
    ).toBe(true);
  });

  test("is idempotent", () => {
    seedRows([{ name: "anthropic", provider: "anthropic" }]);
    writeConfig({
      pinned: {
        provider: "anthropic",
        provider_connection: "anthropic",
        model: "claude-opus-4-8",
      },
    });

    canonicalizeProfileRouteReferencesMigration.run(workspaceDir);
    const first = readProfiles();
    canonicalizeProfileRouteReferencesMigration.run(workspaceDir);
    expect(readProfiles()).toEqual(first);
  });
});

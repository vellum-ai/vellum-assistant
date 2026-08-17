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

import { repairRetiredFireworksDeepseekFlashModelIdMigration } from "../workspace/migrations/146-repair-retired-fireworks-deepseek-flash-model-id.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import { assertNotLiveDb } from "./assert-not-live-db.js";

const STALE = "accounts/fireworks/models/deepseek-v4-flash";
const REPLACEMENT = "accounts/fireworks/models/deepseek-v4-flash-0731";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-146-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
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

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    assertNotLiveDb(workspaceDir);
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("146-repair-retired-fireworks-deepseek-flash-model-id migration", () => {
  test("has correct migration id and is registered", () => {
    expect(repairRetiredFireworksDeepseekFlashModelIdMigration.id).toBe(
      "146-repair-retired-fireworks-deepseek-flash-model-id",
    );
    expect(WORKSPACE_MIGRATIONS.map((m) => m.id)).toContain(
      "146-repair-retired-fireworks-deepseek-flash-model-id",
    );
  });

  test("repairs the stale ID in default, call sites, and profiles", () => {
    writeConfig({
      llm: {
        default: { provider: "fireworks", model: STALE },
        callSites: {
          recall: { model: STALE, maxTokens: 4096 },
          heartbeat: { model: `${STALE}-tuned` },
          malformed: STALE,
        },
        profiles: {
          "cost-optimized": { provider: "vellum", model: STALE },
          legacy: { model: STALE },
        },
      },
    });

    repairRetiredFireworksDeepseekFlashModelIdMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, any>;
    expect(llm.default.model).toBe(REPLACEMENT);
    expect(llm.callSites.recall.model).toBe(REPLACEMENT);
    expect(llm.callSites.recall.maxTokens).toBe(4096);
    // Non-exact matches and malformed leaves are untouched. The dated
    // replacement itself extends the stale ID, so the exact match must not
    // fire on already-repaired leaves.
    expect(llm.callSites.heartbeat.model).toBe(`${STALE}-tuned`);
    expect(llm.callSites.malformed).toBe(STALE);
    // Managed profiles stamped provider "vellum" carry Fireworks model IDs.
    expect(llm.profiles["cost-optimized"].model).toBe(REPLACEMENT);
    expect(llm.profiles.legacy.model).toBe(REPLACEMENT);
  });

  test("repairs entry-bound fragments whose row kind is fireworks or vellum", () => {
    seedRows([
      { name: "my-fireworks", provider: "fireworks" },
      { name: "managed-alt", provider: "vellum" },
    ]);
    writeConfig({
      llm: {
        profiles: {
          bound: { provider: "my-fireworks", model: STALE },
          managed: { provider: "managed-alt", model: STALE },
        },
      },
    });

    repairRetiredFireworksDeepseekFlashModelIdMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, any>;
    expect(llm.profiles.bound.model).toBe(REPLACEMENT);
    expect(llm.profiles.managed.model).toBe(REPLACEMENT);
  });

  test("leaves fragments with an explicit other provider untouched", () => {
    seedRows([{ name: "byo-compat", provider: "openai-compatible" }]);
    writeConfig({
      llm: {
        default: { provider: "openai-compatible", model: STALE },
        profiles: {
          byo: { provider: "openai-compatible", model: STALE },
          // Entry-bound profile whose row kind is not repairable.
          compatBound: { provider: "byo-compat", model: STALE },
          // Entry name with no row: dangling, so nothing proves it is a
          // fireworks-kind route.
          dangling: { provider: "ghost", model: STALE },
        },
      },
    });

    repairRetiredFireworksDeepseekFlashModelIdMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, any>;
    expect(llm.default.model).toBe(STALE);
    expect(llm.profiles.byo.model).toBe(STALE);
    expect(llm.profiles.compatBound.model).toBe(STALE);
    expect(llm.profiles.dangling.model).toBe(STALE);
  });

  test("leaves entry-name providers untouched when no DB file exists", () => {
    writeConfig({
      llm: {
        profiles: { bound: { provider: "my-fireworks", model: STALE } },
      },
    });

    repairRetiredFireworksDeepseekFlashModelIdMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, any>;
    expect(llm.profiles.bound.model).toBe(STALE);
  });

  test("throws when an entry-name provider needs rows and the DB is unreadable", () => {
    // A DB file without the provider_connections table is unqueryable, so
    // the run must fail (and retry later) instead of skipping the profile.
    mkdirSync(join(workspaceDir, "data", "db"), { recursive: true });
    writeFileSync(join(workspaceDir, "data", "db", "assistant.db"), "");
    writeConfig({
      llm: {
        profiles: { bound: { provider: "my-fireworks", model: STALE } },
      },
    });

    expect(() =>
      repairRetiredFireworksDeepseekFlashModelIdMigration.run(workspaceDir),
    ).toThrow();
    const llm = readConfig().llm as Record<string, any>;
    expect(llm.profiles.bound.model).toBe(STALE);

    // Vendor and absent providers never need the rows, so the same broken
    // DB does not block their repair.
    writeConfig({
      llm: {
        default: { provider: "fireworks", model: STALE },
        profiles: { legacy: { model: STALE } },
      },
    });
    repairRetiredFireworksDeepseekFlashModelIdMigration.run(workspaceDir);
    const repaired = readConfig().llm as Record<string, any>;
    expect(repaired.default.model).toBe(REPLACEMENT);
    expect(repaired.profiles.legacy.model).toBe(REPLACEMENT);
  });

  test("is idempotent and a no-op without the stale ID", () => {
    writeConfig({
      llm: {
        default: { provider: "fireworks", model: STALE },
        profiles: { fine: { provider: "fireworks", model: REPLACEMENT } },
      },
    });

    repairRetiredFireworksDeepseekFlashModelIdMigration.run(workspaceDir);
    const first = readConfig();
    repairRetiredFireworksDeepseekFlashModelIdMigration.run(workspaceDir);
    expect(readConfig()).toEqual(first);

    const llm = first.llm as Record<string, any>;
    expect(llm.default.model).toBe(REPLACEMENT);
    expect(llm.profiles.fine.model).toBe(REPLACEMENT);
  });

  test("handles missing config, missing llm block, and invalid JSON", () => {
    // No config.json at all.
    expect(() =>
      repairRetiredFireworksDeepseekFlashModelIdMigration.run(workspaceDir),
    ).not.toThrow();

    writeConfig({ theme: "dark" });
    repairRetiredFireworksDeepseekFlashModelIdMigration.run(workspaceDir);
    expect(readConfig()).toEqual({ theme: "dark" });

    writeFileSync(join(workspaceDir, "config.json"), "{not json");
    expect(() =>
      repairRetiredFireworksDeepseekFlashModelIdMigration.run(workspaceDir),
    ).not.toThrow();
  });
});

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

import { repairRetiredCodexGpt54ModelIdsMigration } from "../workspace/migrations/153-repair-retired-codex-gpt-5-4-model-ids.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import { assertNotLiveDb } from "./assert-not-live-db.js";

const STALE = "gpt-5.4";
const STALE_MINI = "gpt-5.4-mini";
const REPLACEMENT = "gpt-5.5";
const REPLACEMENT_MINI = "gpt-5.6-luna";

const API_KEY_AUTH = '{"type":"api_key","credential":"credential/openai"}';
const SUBSCRIPTION_AUTH =
  '{"type":"oauth_subscription","credential":"credential/chatgpt"}';

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-153-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

function seedRows(
  rows: Array<{ name: string; provider: string; auth: string }>,
): void {
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
      `INSERT INTO provider_connections (name, provider, auth, created_at, updated_at) VALUES (?, ?, ?, 1, 1)`,
    ).run(row.name, row.provider, row.auth);
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

describe("153-repair-retired-codex-gpt-5-4-model-ids migration", () => {
  test("has correct migration id and is registered", () => {
    expect(repairRetiredCodexGpt54ModelIdsMigration.id).toBe(
      "153-repair-retired-codex-gpt-5-4-model-ids",
    );
    expect(WORKSPACE_MIGRATIONS.map((m) => m.id)).toContain(
      "153-repair-retired-codex-gpt-5-4-model-ids",
    );
  });

  test("repairs chatgpt fragments in default, call sites, and profiles", () => {
    writeConfig({
      llm: {
        default: { provider: "chatgpt", model: STALE },
        callSites: {
          recall: { provider: "chatgpt", model: STALE_MINI, maxTokens: 4096 },
          heartbeat: { provider: "chatgpt", model: `${STALE}-tuned` },
          malformed: STALE,
        },
        profiles: {
          codex: { provider: "chatgpt", model: STALE, source: "user" },
          budget: { provider: "chatgpt", model: STALE_MINI },
          current: { provider: "chatgpt", model: "gpt-5.6-terra" },
        },
      },
    });

    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, any>;
    expect(llm.default.model).toBe(REPLACEMENT);
    expect(llm.callSites.recall.model).toBe(REPLACEMENT_MINI);
    expect(llm.callSites.recall.maxTokens).toBe(4096);
    // Non-exact matches and malformed leaves are untouched.
    expect(llm.callSites.heartbeat.model).toBe(`${STALE}-tuned`);
    expect(llm.callSites.malformed).toBe(STALE);
    expect(llm.profiles.codex.model).toBe(REPLACEMENT);
    expect(llm.profiles.codex.source).toBe("user");
    expect(llm.profiles.budget.model).toBe(REPLACEMENT_MINI);
    expect(llm.profiles.current.model).toBe("gpt-5.6-terra");
  });

  test("repairs entry-bound fragments whose row is the subscription", () => {
    seedRows([
      // Post-DB-migration-366 row shape.
      {
        name: "chatgpt-subscription",
        provider: "chatgpt",
        auth: SUBSCRIPTION_AUTH,
      },
      // Pre-366 row shape: provider still openai, auth proves the route.
      { name: "legacy-sub", provider: "openai", auth: SUBSCRIPTION_AUTH },
    ]);
    writeConfig({
      llm: {
        profiles: {
          bound: { provider: "chatgpt-subscription", model: STALE },
          legacy: { provider: "legacy-sub", model: STALE_MINI },
        },
      },
    });

    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, any>;
    expect(llm.profiles.bound.model).toBe(REPLACEMENT);
    expect(llm.profiles.legacy.model).toBe(REPLACEMENT_MINI);
  });

  test("leaves API-key, other-vendor, providerless, and dangling fragments untouched", () => {
    seedRows([{ name: "openai-key", provider: "openai", auth: API_KEY_AUTH }]);
    const config = {
      llm: {
        // Explicit vendors keep the model: API-key OpenAI still serves it
        // and an openai-compatible endpoint may too.
        default: { provider: "openai", model: STALE },
        callSites: {
          // A providerless call-site pin rides the winning profile, which
          // may be an API-key or managed route.
          recall: { model: STALE },
          vision: { provider: "openai-compatible", model: STALE_MINI },
        },
        profiles: {
          byok: { provider: "openai", model: STALE_MINI },
          inherited: { model: STALE },
          keyBound: { provider: "openai-key", model: STALE },
          // Entry name with no row: nothing proves it is the subscription.
          dangling: { provider: "ghost", model: STALE },
        },
      },
    };
    writeConfig(config);
    const before = readFileSync(join(workspaceDir, "config.json"), "utf-8");

    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);

    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      before,
    );
  });

  test("leaves entry-name providers untouched when no DB file exists", () => {
    writeConfig({
      llm: {
        profiles: { bound: { provider: "chatgpt-subscription", model: STALE } },
      },
    });

    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);

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
        profiles: { bound: { provider: "chatgpt-subscription", model: STALE } },
      },
    });

    expect(() =>
      repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir),
    ).toThrow();
    const llm = readConfig().llm as Record<string, any>;
    expect(llm.profiles.bound.model).toBe(STALE);

    // The identity form never needs the rows, so the same broken DB does
    // not block its repair.
    writeConfig({
      llm: { default: { provider: "chatgpt", model: STALE } },
    });
    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);
    const repaired = readConfig().llm as Record<string, any>;
    expect(repaired.default.model).toBe(REPLACEMENT);
  });

  test("is idempotent and a no-op without the stale IDs", () => {
    writeConfig({
      llm: {
        default: { provider: "chatgpt", model: STALE },
        profiles: { fine: { provider: "chatgpt", model: REPLACEMENT } },
      },
    });

    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);
    const first = readConfig();
    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);
    expect(readConfig()).toEqual(first);

    const llm = first.llm as Record<string, any>;
    expect(llm.default.model).toBe(REPLACEMENT);
    expect(llm.profiles.fine.model).toBe(REPLACEMENT);
  });

  test("handles missing config, missing llm block, and invalid JSON", () => {
    expect(() =>
      repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir),
    ).not.toThrow();

    writeConfig({ theme: "dark" });
    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);
    expect(readConfig()).toEqual({ theme: "dark" });

    writeFileSync(join(workspaceDir, "config.json"), "{not json");
    expect(() =>
      repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir),
    ).not.toThrow();
  });
});

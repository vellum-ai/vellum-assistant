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

import { repairRetiredCodexGpt54ModelIdsMigration } from "../workspace/migrations/154-repair-retired-codex-gpt-5-4-model-ids.js";
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
    `vellum-migration-154-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("154-repair-retired-codex-gpt-5-4-model-ids migration", () => {
  test("has correct migration id and is registered", () => {
    expect(repairRetiredCodexGpt54ModelIdsMigration.id).toBe(
      "154-repair-retired-codex-gpt-5-4-model-ids",
    );
    expect(WORKSPACE_MIGRATIONS.map((m) => m.id)).toContain(
      "154-repair-retired-codex-gpt-5-4-model-ids",
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
          // The identity fails schema validation regardless of a stray
          // binding, so it is repaired without consulting the rows.
          strayBinding: {
            provider: "chatgpt",
            provider_connection: "openai-key",
            model: STALE,
          },
        },
      },
    });

    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, any>;
    expect(llm.default.model).toBe(REPLACEMENT);
    expect(llm.profiles.strayBinding.model).toBe(REPLACEMENT);
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
        default: {
          provider: "openai",
          provider_connection: "chatgpt-subscription",
          model: STALE,
        },
        profiles: {
          bound: { provider: "chatgpt-subscription", model: STALE },
          legacy: { provider: "legacy-sub", model: STALE_MINI },
          // Legacy binding: dispatch honors it ahead of the declared
          // provider and accepts the ChatGPT row for openai.
          pinned: {
            provider: "openai",
            provider_connection: "chatgpt-subscription",
            model: STALE,
          },
        },
      },
    });

    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, any>;
    expect(llm.default.model).toBe(REPLACEMENT);
    expect(llm.profiles.bound.model).toBe(REPLACEMENT);
    expect(llm.profiles.legacy.model).toBe(REPLACEMENT_MINI);
    expect(llm.profiles.pinned.model).toBe(REPLACEMENT);
  });

  test("leaves API-key, other-vendor, providerless, and dangling fragments untouched", () => {
    seedRows([
      { name: "openai-key", provider: "openai", auth: API_KEY_AUTH },
      {
        name: "chatgpt-subscription",
        provider: "chatgpt",
        auth: SUBSCRIPTION_AUTH,
      },
    ]);
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
          // Dispatch honors the explicit binding ahead of the provider.
          keyOverride: {
            provider: "chatgpt-subscription",
            provider_connection: "openai-key",
            model: STALE,
          },
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

  test("repairs providerless call-site pins whose winner is subscription-routed", () => {
    seedRows([
      {
        name: "chatgpt-subscription",
        provider: "chatgpt",
        auth: SUBSCRIPTION_AUTH,
      },
    ]);
    writeConfig({
      llm: {
        activeProfile: "codex",
        defaultProvider: { provider: "chatgpt" },
        callSites: {
          // activeProfile wins mainAgent only.
          mainAgent: { model: STALE },
          // An explicit site profile on the chatgpt identity.
          recall: { profile: "codex", model: STALE_MINI },
          // A site profile bound to the subscription row.
          heartbeatAgent: { profile: "bound", model: STALE },
          // A legacy binding to the subscription row.
          filingAgent: { profile: "legacyBound", model: STALE },
          // No named rung: the default column of the chatgpt default provider.
          compactionAgent: { model: STALE_MINI },
          // A default key with no user shadow resolves through defaultProvider.
          memoryRouter: { profile: "balanced", model: STALE },
          // A missing site profile falls through to the default provider.
          vision: { profile: "ghost", model: STALE },
          // A mix whose every arm is subscription-routed.
          memoryV2Sweep: { profile: "blend", model: STALE_MINI },
        },
        profiles: {
          codex: { provider: "chatgpt", model: "gpt-5.6-terra" },
          bound: { provider: "chatgpt-subscription", model: "gpt-5.5" },
          blend: {
            mix: [
              { profile: "codex", weight: 3 },
              { profile: "bound", weight: 1 },
            ],
          },
          legacyBound: {
            provider: "openai",
            provider_connection: "chatgpt-subscription",
            model: "gpt-5.5",
          },
          balanced: { source: "managed" },
        },
      },
    });

    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, any>;
    expect(llm.callSites.mainAgent.model).toBe(REPLACEMENT);
    expect(llm.callSites.recall.model).toBe(REPLACEMENT_MINI);
    expect(llm.callSites.heartbeatAgent.model).toBe(REPLACEMENT);
    expect(llm.callSites.filingAgent.model).toBe(REPLACEMENT);
    expect(llm.callSites.compactionAgent.model).toBe(REPLACEMENT_MINI);
    expect(llm.callSites.memoryRouter.model).toBe(REPLACEMENT);
    expect(llm.callSites.vision.model).toBe(REPLACEMENT);
    expect(llm.callSites.memoryV2Sweep.model).toBe(REPLACEMENT_MINI);
  });

  test("repairs providerless call-site pins under an openai default provider pinning the subscription row", () => {
    seedRows([
      {
        name: "chatgpt-subscription",
        provider: "openai",
        auth: SUBSCRIPTION_AUTH,
      },
    ]);
    writeConfig({
      llm: {
        defaultProvider: {
          provider: "openai",
          connectionName: "chatgpt-subscription",
        },
        callSites: { recall: { model: STALE } },
      },
    });

    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, any>;
    expect(llm.callSites.recall.model).toBe(REPLACEMENT);
  });

  test("resolves a skipped named rung through the site's shipped intent", () => {
    // A disabled site pin falls through to the site's intent, which a
    // user-owned subscription shadow of that key wins even under a
    // non-subscription default provider.
    writeConfig({
      llm: {
        defaultProvider: { provider: "vellum" },
        callSites: {
          heartbeatAgent: { profile: "off", model: STALE },
          recall: { profile: "off", model: STALE },
        },
        profiles: {
          off: { provider: "chatgpt", model: "gpt-5.5", status: "disabled" },
          "cost-optimized": { provider: "chatgpt", model: "gpt-5.6-luna" },
        },
      },
    });
    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);
    let llm = readConfig().llm as Record<string, any>;
    // heartbeatAgent ships the cost-optimized intent; recall ships balanced,
    // whose catalog column is the vellum default provider's.
    expect(llm.callSites.heartbeatAgent.model).toBe(REPLACEMENT);
    expect(llm.callSites.recall.model).toBe(STALE);

    // The reverse: a user-owned API-key shadow of the intent wins over a
    // chatgpt default provider.
    writeConfig({
      llm: {
        defaultProvider: { provider: "chatgpt" },
        callSites: {
          recall: { model: STALE },
          heartbeatAgent: { model: STALE_MINI },
        },
        profiles: {
          balanced: { provider: "openai", model: "gpt-5.5" },
        },
      },
    });
    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);
    llm = readConfig().llm as Record<string, any>;
    expect(llm.callSites.recall.model).toBe(STALE);
    expect(llm.callSites.heartbeatAgent.model).toBe(REPLACEMENT_MINI);
  });

  test("ignores user-owned shadows of code-owned profile names", () => {
    // Resolution serves the code-owned body for these names, so a
    // subscription shadow does not make the vellum column's winner
    // subscription-routed, and an API-key shadow does not hide the chatgpt
    // column's winner.
    writeConfig({
      llm: {
        defaultProvider: { provider: "vellum" },
        callSites: { voiceFrontDoor: { model: STALE } },
        profiles: {
          "latency-optimized": { provider: "chatgpt", model: "gpt-5.5" },
        },
      },
    });
    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);
    let llm = readConfig().llm as Record<string, any>;
    expect(llm.callSites.voiceFrontDoor.model).toBe(STALE);

    writeConfig({
      llm: {
        defaultProvider: { provider: "chatgpt" },
        callSites: {
          voiceFrontDoor: { model: STALE },
          recall: { profile: "balanced-backup", model: STALE_MINI },
        },
        profiles: {
          "latency-optimized": { provider: "openai", model: "gpt-5.5" },
          "balanced-backup": { provider: "openai", model: "gpt-5.5" },
        },
      },
    });
    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);
    llm = readConfig().llm as Record<string, any>;
    expect(llm.callSites.voiceFrontDoor.model).toBe(REPLACEMENT);
    // A backup shadow is ignored too, and the backup does not exist on the
    // chatgpt column, so the rung is skipped in favor of the shipped intent.
    expect(llm.callSites.recall.model).toBe(REPLACEMENT_MINI);
  });

  test("skips a named rung whose provider names no connection row", () => {
    seedRows([
      {
        name: "chatgpt-subscription",
        provider: "chatgpt",
        auth: SUBSCRIPTION_AUTH,
      },
    ]);
    writeConfig({
      llm: {
        defaultProvider: { provider: "chatgpt" },
        callSites: { recall: { profile: "gone", model: STALE } },
        profiles: { gone: { provider: "ghost", model: "gpt-5.5" } },
      },
    });
    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);
    let llm = readConfig().llm as Record<string, any>;
    // The dangling rung is skipped, so the chatgpt default column wins.
    expect(llm.callSites.recall.model).toBe(REPLACEMENT);

    // With the row present the profile is usable and its API-key route
    // keeps the model.
    seedRows([{ name: "ghost", provider: "openai", auth: API_KEY_AUTH }]);
    writeConfig({
      llm: {
        defaultProvider: { provider: "chatgpt" },
        callSites: { recall: { profile: "gone", model: STALE } },
        profiles: { gone: { provider: "ghost", model: "gpt-5.5" } },
      },
    });
    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);
    llm = readConfig().llm as Record<string, any>;
    expect(llm.callSites.recall.model).toBe(STALE);
  });

  test("resolves a materialized OS Beta stub to its code-owned body", () => {
    // The stub expands to the vellum body, which still serves the model.
    writeConfig({
      llm: {
        defaultProvider: { provider: "chatgpt" },
        callSites: { recall: { profile: "os-beta", model: STALE } },
        profiles: { "os-beta": { source: "managed" } },
      },
    });
    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);
    let llm = readConfig().llm as Record<string, any>;
    expect(llm.callSites.recall.model).toBe(STALE);

    // A disabled stub, or no stub at all, skips the rung.
    writeConfig({
      llm: {
        defaultProvider: { provider: "chatgpt" },
        callSites: {
          recall: { profile: "os-beta", model: STALE },
          heartbeatAgent: { profile: "os-beta", model: STALE_MINI },
        },
        profiles: { "os-beta": { source: "managed", status: "disabled" } },
      },
    });
    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);
    llm = readConfig().llm as Record<string, any>;
    expect(llm.callSites.recall.model).toBe(REPLACEMENT);
    expect(llm.callSites.heartbeatAgent.model).toBe(REPLACEMENT_MINI);
  });

  test("anchors a mix with unusable arms on the rest of the chain", () => {
    const profiles = {
      codex: { provider: "chatgpt", model: "gpt-5.6-terra" },
      off: { provider: "chatgpt", model: "gpt-5.5", status: "disabled" },
      blend: {
        mix: [
          { profile: "codex", weight: 1 },
          { profile: "off", weight: 1 },
        ],
      },
      allOff: {
        mix: [
          { profile: "off", weight: 1 },
          { profile: "off", weight: 1 },
        ],
      },
    };

    // Seeds that pick the disabled arm skip the rung and land on the
    // chatgpt default column, so every seed routes through the subscription.
    writeConfig({
      llm: {
        defaultProvider: { provider: "chatgpt" },
        callSites: {
          recall: { profile: "blend", model: STALE },
          heartbeatAgent: { profile: "allOff", model: STALE_MINI },
        },
        profiles,
      },
    });
    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);
    let llm = readConfig().llm as Record<string, any>;
    expect(llm.callSites.recall.model).toBe(REPLACEMENT);
    expect(llm.callSites.heartbeatAgent.model).toBe(REPLACEMENT_MINI);

    // Under a vellum default those seeds still serve the model.
    writeConfig({
      llm: {
        defaultProvider: { provider: "vellum" },
        callSites: { recall: { profile: "blend", model: STALE } },
        profiles,
      },
    });
    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);
    llm = readConfig().llm as Record<string, any>;
    expect(llm.callSites.recall.model).toBe(STALE);
  });

  test("leaves providerless call-site pins alone when the winner is not subscription-routed", () => {
    seedRows([{ name: "openai-key", provider: "openai", auth: API_KEY_AUTH }]);
    const config = {
      llm: {
        activeProfile: "codex",
        defaultProvider: { provider: "vellum" },
        callSites: {
          // activeProfile does not win non-mainAgent sites.
          recall: { model: STALE },
          // An API-key openai winner still serves the model.
          heartbeatAgent: { profile: "byok", model: STALE },
          // An entry-bound API-key winner.
          filingAgent: { profile: "keyBound", model: STALE_MINI },
          // A disabled chatgpt site profile falls through to the vellum
          // default column.
          compactionAgent: { profile: "off", model: STALE },
          // A mix with an API-key arm is ambiguous.
          memoryRouter: { profile: "blend", model: STALE },
        },
        profiles: {
          codex: { provider: "chatgpt", model: "gpt-5.6-terra" },
          byok: { provider: "openai", model: "gpt-5.5" },
          keyBound: { provider: "openai-key", model: "gpt-5.5" },
          off: { provider: "chatgpt", model: "gpt-5.5", status: "disabled" },
          blend: {
            mix: [
              { profile: "codex", weight: 1 },
              { profile: "byok", weight: 1 },
            ],
          },
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

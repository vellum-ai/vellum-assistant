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

import { LLMCallSiteEnum } from "../config/schemas/llm.js";
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

function readLlm(): Record<string, any> {
  return readConfig().llm as Record<string, any>;
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

const SUBSCRIPTION_ROW = {
  name: "chatgpt-subscription",
  provider: "chatgpt",
  auth: SUBSCRIPTION_AUTH,
};
const API_KEY_ROW = {
  name: "openai-key",
  provider: "openai",
  auth: API_KEY_AUTH,
};

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

    const llm = readLlm();
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
    expect(llm.profiles.strayBinding.model).toBe(REPLACEMENT);
  });

  test("repairs entry-bound fragments whose row is the subscription", () => {
    seedRows([
      // Post-DB-migration-366 row shape.
      SUBSCRIPTION_ROW,
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

    const llm = readLlm();
    expect(llm.default.model).toBe(REPLACEMENT);
    expect(llm.profiles.bound.model).toBe(REPLACEMENT);
    expect(llm.profiles.legacy.model).toBe(REPLACEMENT_MINI);
    expect(llm.profiles.pinned.model).toBe(REPLACEMENT);
  });

  test("judges a provider_connection as a row even when named like a vendor", () => {
    seedRows([
      { name: "openai", provider: "openai", auth: SUBSCRIPTION_AUTH },
      { name: "chatgpt", provider: "openai", auth: API_KEY_AUTH },
    ]);
    writeConfig({
      llm: {
        profiles: {
          subRow: {
            provider: "openai",
            provider_connection: "openai",
            model: STALE,
          },
          keyRow: {
            provider: "chatgpt-subscription",
            provider_connection: "chatgpt",
            model: STALE_MINI,
          },
        },
      },
    });

    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);

    const llm = readLlm();
    expect(llm.profiles.subRow.model).toBe(REPLACEMENT);
    expect(llm.profiles.keyRow.model).toBe(STALE_MINI);
  });

  test("leaves API-key, other-vendor, and dangling fragments untouched", () => {
    seedRows([API_KEY_ROW, SUBSCRIPTION_ROW]);
    const config = {
      llm: {
        // Explicit vendors keep the model: API-key OpenAI still serves it
        // and an openai-compatible endpoint may too.
        default: { provider: "openai", model: STALE },
        callSites: {
          vision: { provider: "openai-compatible", model: STALE_MINI },
        },
        profiles: {
          byok: { provider: "openai", model: STALE_MINI },
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

  test("repairs providerless call-site pins when a selectable profile is subscription-routed", () => {
    seedRows([API_KEY_ROW, SUBSCRIPTION_ROW]);
    const callSites = {
      mainAgent: { model: STALE },
      recall: { model: STALE_MINI },
      // A stale pin under a site profile that is not itself subscription-
      // routed: another selectable profile can still be pinned over it.
      heartbeatAgent: { profile: "byok", model: STALE },
      // Every shipped site is known, including the ones added after the
      // call-site enum's first tranche.
      guardianQuestionCopy: { model: STALE_MINI },
      workflowLeaf: { model: STALE },
    };
    const cases: Array<Record<string, unknown>> = [
      // The default keys resolve to the chatgpt column.
      { defaultProvider: { provider: "chatgpt" } },
      // An openai default provider pinning the subscription row.
      {
        defaultProvider: {
          provider: "openai",
          connectionName: "chatgpt-subscription",
        },
      },
      // A user-owned profile on the chatgpt identity, selected nowhere.
      {
        defaultProvider: { provider: "vellum" },
        profiles: { codex: { provider: "chatgpt", model: "gpt-5.6-terra" } },
      },
      // A user-owned profile bound to the subscription row.
      {
        defaultProvider: { provider: "vellum" },
        profiles: {
          bound: { provider: "chatgpt-subscription", model: "gpt-5.5" },
        },
      },
      // A legacy binding to the subscription row.
      {
        defaultProvider: { provider: "vellum" },
        profiles: {
          legacyBound: {
            provider: "openai",
            provider_connection: "chatgpt-subscription",
            model: "gpt-5.5",
          },
        },
      },
      // A user-owned shadow of a default key on the chatgpt identity under
      // a vellum default provider.
      {
        defaultProvider: { provider: "vellum" },
        profiles: { balanced: { provider: "chatgpt", model: "gpt-5.5" } },
      },
      // The advisor profile is one selectable profile among the rest.
      {
        defaultProvider: { provider: "vellum" },
        advisorProfile: "advisor",
        profiles: { advisor: { provider: "chatgpt", model: "gpt-5.5" } },
      },
    ];

    for (const llmCase of cases) {
      writeConfig({
        llm: {
          activeProfile: "byok",
          ...llmCase,
          callSites,
          profiles: {
            byok: { provider: "openai", model: "gpt-5.5" },
            ...((llmCase.profiles as Record<string, unknown>) ?? {}),
          },
        },
      });
      repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);
      const llm = readLlm();
      expect(llm.callSites.mainAgent.model).toBe(REPLACEMENT);
      expect(llm.callSites.recall.model).toBe(REPLACEMENT_MINI);
      expect(llm.callSites.heartbeatAgent.model).toBe(REPLACEMENT);
      expect(llm.callSites.guardianQuestionCopy.model).toBe(REPLACEMENT_MINI);
      expect(llm.callSites.workflowLeaf.model).toBe(REPLACEMENT);
    }
  });

  test("leaves providerless call-site pins alone when no selectable profile is subscription-routed", () => {
    seedRows([API_KEY_ROW, SUBSCRIPTION_ROW]);
    const config = {
      llm: {
        activeProfile: "byok",
        defaultProvider: { provider: "vellum" },
        callSites: {
          mainAgent: { model: STALE },
          recall: { model: STALE_MINI },
          voiceFrontDoor: { model: STALE },
          heartbeatAgent: { profile: "off", model: STALE },
        },
        profiles: {
          byok: { provider: "openai", model: "gpt-5.5" },
          keyBound: { provider: "openai-key", model: "gpt-5.5" },
          // Disabled, incomplete, or row-unresolvable profiles cannot win.
          off: { provider: "chatgpt", model: "gpt-5.5", status: "disabled" },
          partial: { provider: "chatgpt" },
          gone: { provider: "ghost", model: "gpt-5.5" },
          // A mix adds nothing beyond its arms.
          blend: {
            mix: [
              { profile: "byok", weight: 1 },
              { profile: "off", weight: 1 },
            ],
          },
          // Shadows of code-owned names are ignored in favor of the
          // code-owned body, and a materialized OS Beta stub is its vellum
          // body.
          "latency-optimized": { provider: "chatgpt", model: "gpt-5.5" },
          "balanced-backup": { provider: "chatgpt", model: "gpt-5.5" },
          "os-beta": { source: "managed" },
          // A managed stub of a default key is the vellum column.
          "cost-optimized": { source: "managed" },
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

  test("judges a disabled shadow of a default key by the column it reverts to", () => {
    // A disabled user-owned shadow of a default key reverts to the default
    // provider's column, so the chatgpt column still makes it selectable.
    writeConfig({
      llm: {
        defaultProvider: { provider: "chatgpt" },
        callSites: { recall: { model: STALE } },
        profiles: {
          balanced: {
            provider: "openai",
            model: "gpt-5.5",
            status: "disabled",
          },
          "quality-optimized": { provider: "openai", model: "gpt-5.5" },
          "cost-optimized": { provider: "openai", model: "gpt-5.5" },
        },
      },
    });
    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);
    expect(readLlm().callSites.recall.model).toBe(REPLACEMENT);

    // Usable API-backed shadows of every default key hide the column.
    writeConfig({
      llm: {
        defaultProvider: { provider: "chatgpt" },
        callSites: { recall: { model: STALE } },
        profiles: {
          balanced: { provider: "openai", model: "gpt-5.5" },
          "quality-optimized": { provider: "openai", model: "gpt-5.5" },
          "cost-optimized": { provider: "openai", model: "gpt-5.5" },
          "latency-optimized": { provider: "openai", model: "gpt-5.5" },
        },
      },
    });
    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);
    // latency-optimized is code-owned, so its shadow is ignored and the
    // column stays selectable.
    expect(readLlm().callSites.recall.model).toBe(REPLACEMENT);
  });

  test("knows every shipped call site", () => {
    const callSites = Object.fromEntries(
      LLMCallSiteEnum.options.map((site, i) => [
        site,
        { model: i % 2 === 0 ? STALE : STALE_MINI },
      ]),
    );
    writeConfig({
      llm: { defaultProvider: { provider: "chatgpt" }, callSites },
    });

    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);

    const llm = readLlm();
    for (const [i, site] of LLMCallSiteEnum.options.entries()) {
      expect(llm.callSites[site].model).toBe(
        i % 2 === 0 ? REPLACEMENT : REPLACEMENT_MINI,
      );
    }
  });

  test("leaves providerless pins on unknown call sites alone", () => {
    writeConfig({
      llm: {
        defaultProvider: { provider: "chatgpt" },
        callSites: {
          // A site this migration does not know may resolve differently on
          // the newer assistant that wrote it.
          futureSite: { model: STALE },
          // Its own routing is still judged.
          futureIdentitySite: { provider: "chatgpt", model: STALE_MINI },
          vision: { model: STALE },
        },
      },
    });
    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);
    const llm = readLlm();
    expect(llm.callSites.futureSite.model).toBe(STALE);
    expect(llm.callSites.futureIdentitySite.model).toBe(REPLACEMENT_MINI);
    expect(llm.callSites.vision.model).toBe(REPLACEMENT);
  });

  test("leaves entry-name providers untouched when no DB file exists", () => {
    writeConfig({
      llm: {
        callSites: { recall: { model: STALE } },
        profiles: {
          bound: { provider: "chatgpt-subscription", model: STALE },
          candidate: { provider: "chatgpt-subscription", model: "gpt-5.5" },
        },
      },
    });

    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);

    const llm = readLlm();
    expect(llm.profiles.bound.model).toBe(STALE);
    expect(llm.callSites.recall.model).toBe(STALE);
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
    expect(readLlm().profiles.bound.model).toBe(STALE);

    // The identity form never needs the rows, so the same broken DB does
    // not block its repair.
    writeConfig({
      llm: { default: { provider: "chatgpt", model: STALE } },
    });
    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);
    expect(readLlm().default.model).toBe(REPLACEMENT);
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

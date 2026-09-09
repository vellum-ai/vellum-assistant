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

  test("leaves API-key, other-vendor, and dangling fragments untouched", () => {
    seedRows([API_KEY_ROW, SUBSCRIPTION_ROW]);
    const config = {
      llm: {
        // Explicit vendors keep the model: API-key OpenAI still serves it
        // and an openai-compatible endpoint may too.
        default: { provider: "openai", model: STALE },
        callSites: {
          vision: { provider: "openai-compatible", model: STALE_MINI },
          recall: { provider: "openai", model: STALE },
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

  test("repairs every providerless pin on a known call site", () => {
    // The winner a providerless pin overlays is not fixed by today's
    // config, so the pin is repaired whatever the workspace looks like:
    // here an API-key-only workspace with no subscription profile at all.
    const callSites = Object.fromEntries(
      LLMCallSiteEnum.options.map((site, i) => [
        site,
        { model: i % 2 === 0 ? STALE : STALE_MINI },
      ]),
    );
    writeConfig({
      llm: {
        activeProfile: "byok",
        defaultProvider: { provider: "openai" },
        callSites,
        profiles: { byok: { provider: "openai", model: "gpt-5.5" } },
      },
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
        callSites: {
          // A site this migration does not know may resolve differently on
          // the newer assistant that wrote it.
          futureSite: { model: STALE },
          // Its own routing is still judged.
          futureIdentitySite: { provider: "chatgpt", model: STALE_MINI },
          recall: { model: STALE },
        },
      },
    });

    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);

    const llm = readLlm();
    expect(llm.callSites.futureSite.model).toBe(STALE);
    expect(llm.callSites.futureIdentitySite.model).toBe(REPLACEMENT_MINI);
    expect(llm.callSites.recall.model).toBe(REPLACEMENT);
  });

  test("needs no DB for identity, vendor, or providerless fragments", () => {
    writeConfig({
      llm: {
        default: { provider: "chatgpt", model: STALE },
        callSites: { recall: { model: STALE } },
        profiles: {
          byok: { provider: "openai", model: STALE },
          bound: { provider: "chatgpt-subscription", model: STALE },
        },
      },
    });

    repairRetiredCodexGpt54ModelIdsMigration.run(workspaceDir);

    const llm = readLlm();
    expect(llm.default.model).toBe(REPLACEMENT);
    expect(llm.callSites.recall.model).toBe(REPLACEMENT);
    expect(llm.profiles.byok.model).toBe(STALE);
    // An entry name with no DB file is dangling.
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

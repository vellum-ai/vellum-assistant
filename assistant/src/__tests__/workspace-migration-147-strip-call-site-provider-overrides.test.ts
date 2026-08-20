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

import { stripCallSiteProviderOverridesMigration } from "../workspace/migrations/147-strip-call-site-provider-overrides.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import { assertNotLiveDb } from "./assert-not-live-db.js";

let workspaceDir: string;

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readCallSites(): Record<string, Record<string, unknown>> {
  const raw = JSON.parse(
    readFileSync(join(workspaceDir, "config.json"), "utf-8"),
  ) as { llm?: { callSites?: Record<string, Record<string, unknown>> } };
  return raw.llm?.callSites ?? {};
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
  stripCallSiteProviderOverridesMigration.run(workspaceDir);
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

describe("147-strip-call-site-provider-overrides", () => {
  test("is registered last (the registry ceiling reads the final entry)", () => {
    expect(stripCallSiteProviderOverridesMigration.id).toBe(
      "147-strip-call-site-provider-overrides",
    );
    expect(WORKSPACE_MIGRATIONS[WORKSPACE_MIGRATIONS.length - 1]?.id).toBe(
      "147-strip-call-site-provider-overrides",
    );
  });

  test("strips provider and keeps a model the winning route serves", () => {
    // No defaultProvider: the winning route is the vellum column, which
    // serves the anthropic catalog model.
    writeConfig({
      llm: {
        callSites: {
          conversationSummarization: {
            provider: "anthropic",
            model: "claude-haiku-4-5-20251001",
            maxTokens: 2048,
          },
        },
      },
    });

    run();

    const entry = readCallSites().conversationSummarization;
    expect(entry).not.toHaveProperty("provider");
    expect(entry.model).toBe("claude-haiku-4-5-20251001");
    expect(entry.maxTokens).toBe(2048);
  });

  test("re-sweeps a stray provider_connection", () => {
    writeConfig({
      llm: {
        callSites: {
          recall: {
            provider_connection: "anthropic-personal",
            maxTokens: 1024,
          },
        },
      },
    });

    run();

    const entry = readCallSites().recall;
    expect(entry).not.toHaveProperty("provider_connection");
    expect(entry.maxTokens).toBe(1024);
  });

  test("deletes a tweak whose model the winning route cannot serve", () => {
    // BYOK anthropic default: the winning route for a background site is the
    // anthropic column, which does not serve a gpt model.
    writeConfig({
      llm: {
        defaultProvider: { provider: "anthropic" },
        callSites: {
          conversationSummarization: {
            provider: "openai",
            model: "gpt-5.4-mini",
          },
        },
      },
    });

    run();

    expect(readCallSites()).not.toHaveProperty("conversationSummarization");
  });

  test("a profile pin's provider is the winning route", () => {
    writeConfig({
      llm: {
        profiles: {
          mine: { source: "user", provider: "openai", model: "gpt-5.5" },
        },
        callSites: {
          memoryExtraction: {
            profile: "mine",
            provider: "anthropic",
            model: "gpt-5.4-mini",
          },
          conversationTitle: {
            profile: "mine",
            model: "claude-haiku-4-5-20251001",
          },
        },
      },
    });

    run();

    // The openai winner serves the gpt model: kept, provider stripped.
    const kept = readCallSites().memoryExtraction;
    expect(kept).not.toHaveProperty("provider");
    expect(kept.model).toBe("gpt-5.4-mini");
    expect(kept.profile).toBe("mine");
    // The openai winner does not serve the claude model: tweak deleted.
    expect(readCallSites()).not.toHaveProperty("conversationTitle");
  });

  test("mainAgent judges through the active profile", () => {
    writeConfig({
      llm: {
        profiles: {
          active: {
            source: "user",
            provider: "gemini",
            model: "gemini-2.5-pro",
          },
        },
        activeProfile: "active",
        callSites: {
          mainAgent: { model: "gpt-5.5" },
        },
      },
    });

    run();

    expect(readCallSites()).not.toHaveProperty("mainAgent");
  });

  test("deletes an entry left empty by stripping (and any pre-existing {} entry)", () => {
    writeConfig({
      llm: {
        callSites: {
          recall: { provider: "anthropic" },
          commitMessage: {},
          replySuggestion: { profile: "mine" },
        },
        profiles: {
          mine: {
            source: "user",
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
        },
      },
    });

    run();

    const sites = readCallSites();
    // A present-but-empty tweak would suppress the shipped call-site default.
    expect(sites).not.toHaveProperty("recall");
    expect(sites).not.toHaveProperty("commitMessage");
    // A profile-only entry is not empty and stays.
    expect(sites.replySuggestion).toEqual({ profile: "mine" });
  });

  test("an entry-name winner is judged through its connection row", () => {
    seedRows([{ name: "my-openai", provider: "openai" }]);
    writeConfig({
      llm: {
        profiles: {
          entry: { source: "user", provider: "my-openai", model: "gpt-5.5" },
        },
        callSites: {
          memoryExtraction: { profile: "entry", model: "gpt-5.4-nano" },
          conversationTitle: {
            profile: "entry",
            model: "claude-haiku-4-5-20251001",
          },
        },
      },
    });

    run();

    // The row's openai kind serves the gpt model but not the claude one.
    expect(readCallSites().memoryExtraction.model).toBe("gpt-5.4-nano");
    expect(readCallSites()).not.toHaveProperty("conversationTitle");
  });

  test("fails open when the connection table is missing", () => {
    // DB file exists but carries no provider_connections table: the
    // entry-name winner is indeterminate and the model keeps.
    mkdirSync(join(workspaceDir, "data", "db"), { recursive: true });
    new Database(join(workspaceDir, "data", "db", "assistant.db")).close();
    writeConfig({
      llm: {
        profiles: {
          entry: { source: "user", provider: "my-openai", model: "gpt-5.5" },
        },
        callSites: {
          memoryExtraction: {
            profile: "entry",
            provider: "openai",
            model: "claude-haiku-4-5-20251001",
          },
        },
      },
    });

    expect(() => run()).not.toThrow();

    const entry = readCallSites().memoryExtraction;
    expect(entry).not.toHaveProperty("provider");
    expect(entry.model).toBe("claude-haiku-4-5-20251001");
  });

  test("keeps models on routes whose model set is not code-known", () => {
    writeConfig({
      llm: {
        profiles: {
          local: { source: "user", provider: "ollama", model: "llama3.2" },
        },
        callSites: {
          memoryExtraction: { profile: "local", model: "some-local-pull" },
        },
      },
    });

    run();

    expect(readCallSites().memoryExtraction.model).toBe("some-local-pull");
  });

  test("no-ops without call-site entries and is idempotent", () => {
    writeConfig({
      llm: {
        callSites: {
          conversationSummarization: {
            provider: "anthropic",
            model: "claude-haiku-4-5-20251001",
          },
          recall: { profile: "mine", maxTokens: 512 },
        },
        profiles: {
          mine: {
            source: "user",
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
        },
        defaultProvider: { provider: "anthropic" },
      },
    });

    run();
    const afterFirst = readCallSites();
    run();

    expect(readCallSites()).toEqual(afterFirst);
    expect(afterFirst.recall).toEqual({ profile: "mine", maxTokens: 512 });
  });

  test("down is a documented no-op", () => {
    writeConfig({ llm: { callSites: {} } });
    expect(() =>
      stripCallSiteProviderOverridesMigration.down?.(workspaceDir),
    ).not.toThrow();
  });
});

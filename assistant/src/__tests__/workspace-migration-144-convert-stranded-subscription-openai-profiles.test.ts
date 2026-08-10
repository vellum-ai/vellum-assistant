import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { convertStrandedSubscriptionOpenaiProfilesMigration } from "../workspace/migrations/144-convert-stranded-subscription-openai-profiles.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import { assertNotLiveDb } from "./assert-not-live-db.js";

let workspaceDir: string;

function freshWorkspace(): void {
  // realpathSync canonicalizes macOS's /var -> /private/var symlink so the
  // assertNotLiveDb tmp-root containment check sees matching prefixes.
  workspaceDir = join(
    realpathSync(tmpdir()),
    `vellum-migration-144-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

interface SeedRow {
  name: string;
  provider: string;
  authType: string;
}

function seedConnections(rows: SeedRow[]): void {
  const dbDir = join(workspaceDir, "data", "db");
  mkdirSync(dbDir, { recursive: true });
  const db = new Database(join(dbDir, "assistant.db"));
  db.run(
    `CREATE TABLE IF NOT EXISTS provider_connections (name TEXT PRIMARY KEY, provider TEXT NOT NULL, auth TEXT NOT NULL)`,
  );
  for (const row of rows) {
    db.run(
      `INSERT INTO provider_connections (name, provider, auth) VALUES (?, ?, ?)`,
      [row.name, row.provider, JSON.stringify({ type: row.authType })],
    );
  }
  db.close();
}

// Both on-disk shapes of the canonical row: before DB migration 366 flips
// the provider column, and after.
const SUBSCRIPTION_PRE_366: SeedRow = {
  name: "chatgpt-subscription",
  provider: "openai",
  authType: "oauth_subscription",
};
const SUBSCRIPTION_POST_366: SeedRow = {
  name: "chatgpt-subscription",
  provider: "chatgpt",
  authType: "oauth_subscription",
};
const OPENAI_KEY_ROW: SeedRow = {
  name: "openai-personal",
  provider: "openai",
  authType: "api_key",
};

const STRANDED_CONFIG = {
  llm: {
    defaultProvider: { provider: "openai" },
    profiles: {
      mine: { provider: "openai", model: "gpt-5.5", source: "user" },
      nano: { provider: "openai", model: "gpt-5.4-nano", source: "user" },
      pinned: {
        provider: "openai",
        model: "gpt-5.5",
        provider_connection: "openai-personal",
      },
      other: { provider: "anthropic", model: "claude-sonnet-4-6" },
      managed: { provider: "openai", model: "gpt-5.5", source: "managed" },
    },
    callSites: {
      recall: { provider: "openai", model: "gpt-5.6-luna" },
      malformed: "openai",
    },
  },
};

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    assertNotLiveDb(join(workspaceDir, "data", "db", "assistant.db"));
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("144-convert-stranded-subscription-openai-profiles migration", () => {
  test("has correct migration id and is registered in order", () => {
    expect(convertStrandedSubscriptionOpenaiProfilesMigration.id).toBe(
      "144-convert-stranded-subscription-openai-profiles",
    );
    const index = WORKSPACE_MIGRATIONS.findIndex(
      (migration) =>
        migration.id === "144-convert-stranded-subscription-openai-profiles",
    );
    expect(index).toBeGreaterThan(-1);
    for (const later of WORKSPACE_MIGRATIONS.slice(index + 1)) {
      expect(later.id > "144").toBe(true);
    }
  });

  test.each([
    ["pre-366 row shape", SUBSCRIPTION_PRE_366],
    ["post-366 row shape", SUBSCRIPTION_POST_366],
  ] as const)(
    "converts unpinned openai fragments in a subscription-only workspace (%s)",
    (_label, subscriptionRow) => {
      writeConfig(STRANDED_CONFIG);
      seedConnections([subscriptionRow]);

      convertStrandedSubscriptionOpenaiProfilesMigration.run(workspaceDir);

      const llm = readConfig().llm as Record<string, any>;
      // Codex-servable models are kept; others fall back to terra.
      expect(llm.profiles.mine).toMatchObject({
        provider: "chatgpt",
        model: "gpt-5.5",
      });
      expect(llm.profiles.nano).toMatchObject({
        provider: "chatgpt",
        model: "gpt-5.6-terra",
      });
      expect(llm.callSites.recall).toMatchObject({
        provider: "chatgpt",
        model: "gpt-5.6-luna",
      });
      // Pinned, other-provider, and managed fragments stay untouched.
      expect(llm.profiles.pinned.provider).toBe("openai");
      expect(llm.profiles.other.provider).toBe("anthropic");
      expect(llm.profiles.managed.provider).toBe("openai");
      // The unpinned default provider anchors the code-owned defaults and
      // converts with them.
      expect(llm.defaultProvider).toEqual({ provider: "chatgpt" });
    },
  );

  test("an invalid pin leaf counts as unpinned and is dropped on conversion", () => {
    writeConfig({
      llm: {
        defaultProvider: { provider: "openai", connectionName: null },
        profiles: {
          nullPin: {
            provider: "openai",
            model: "gpt-5.5",
            provider_connection: null,
          },
          emptyPin: {
            provider: "openai",
            model: "gpt-5.5",
            provider_connection: "",
          },
        },
      },
    });
    seedConnections([SUBSCRIPTION_POST_366]);

    convertStrandedSubscriptionOpenaiProfilesMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, any>;
    expect(llm.profiles.nullPin.provider).toBe("chatgpt");
    expect("provider_connection" in llm.profiles.nullPin).toBe(false);
    expect(llm.profiles.emptyPin.provider).toBe("chatgpt");
    expect("provider_connection" in llm.profiles.emptyPin).toBe(false);
    expect(llm.defaultProvider).toEqual({ provider: "chatgpt" });
  });

  test("a pinned defaultProvider connectionName stays untouched", () => {
    writeConfig({
      llm: {
        defaultProvider: {
          provider: "openai",
          connectionName: "openai-personal",
        },
      },
    });
    seedConnections([SUBSCRIPTION_POST_366]);
    const before = readFileSync(join(workspaceDir, "config.json"), "utf-8");

    convertStrandedSubscriptionOpenaiProfilesMigration.run(workspaceDir);

    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      before,
    );
  });

  test("a hidden legacy openai-managed row does not block the conversion", () => {
    writeConfig(STRANDED_CONFIG);
    seedConnections([
      SUBSCRIPTION_POST_366,
      { name: "openai-managed", provider: "openai", authType: "platform" },
    ]);

    convertStrandedSubscriptionOpenaiProfilesMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, any>;
    expect(llm.profiles.mine.provider).toBe("chatgpt");
    expect(llm.defaultProvider).toEqual({ provider: "chatgpt" });
  });

  test("does not convert when an openai api-key connection exists", () => {
    writeConfig(STRANDED_CONFIG);
    seedConnections([SUBSCRIPTION_POST_366, OPENAI_KEY_ROW]);
    const before = readFileSync(join(workspaceDir, "config.json"), "utf-8");

    convertStrandedSubscriptionOpenaiProfilesMigration.run(workspaceDir);

    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      before,
    );
  });

  test("does not convert without the subscription row", () => {
    writeConfig(STRANDED_CONFIG);
    seedConnections([
      { name: "vellum", provider: "vellum", authType: "platform" },
    ]);
    const before = readFileSync(join(workspaceDir, "config.json"), "utf-8");

    convertStrandedSubscriptionOpenaiProfilesMigration.run(workspaceDir);

    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      before,
    );
  });

  test("a claiming key-auth row under the canonical name blocks conversion", () => {
    writeConfig(STRANDED_CONFIG);
    seedConnections([
      { name: "chatgpt-subscription", provider: "openai", authType: "api_key" },
    ]);
    const before = readFileSync(join(workspaceDir, "config.json"), "utf-8");

    convertStrandedSubscriptionOpenaiProfilesMigration.run(workspaceDir);

    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      before,
    );
  });

  test("converts nothing when the DB or its table is absent", () => {
    writeConfig(STRANDED_CONFIG);
    const before = readFileSync(join(workspaceDir, "config.json"), "utf-8");

    convertStrandedSubscriptionOpenaiProfilesMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      before,
    );

    // DB file exists but the table does not.
    const dbDir = join(workspaceDir, "data", "db");
    mkdirSync(dbDir, { recursive: true });
    new Database(join(dbDir, "assistant.db")).close();
    convertStrandedSubscriptionOpenaiProfilesMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      before,
    );
  });

  test("an unreadable existing DB throws so the failed checkpoint retries", () => {
    writeConfig(STRANDED_CONFIG);
    const dbDir = join(workspaceDir, "data", "db");
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, "assistant.db"), "not a sqlite file");

    expect(() =>
      convertStrandedSubscriptionOpenaiProfilesMigration.run(workspaceDir),
    ).toThrow();
    // Nothing converts on the failed attempt.
    const llm = readConfig().llm as Record<string, any>;
    expect(llm.profiles.mine.provider).toBe("openai");
  });

  test("is idempotent and tolerates missing or malformed config", () => {
    expect(() =>
      convertStrandedSubscriptionOpenaiProfilesMigration.run(workspaceDir),
    ).not.toThrow();

    writeFileSync(join(workspaceDir, "config.json"), "not json {{{");
    seedConnections([SUBSCRIPTION_POST_366]);
    expect(() =>
      convertStrandedSubscriptionOpenaiProfilesMigration.run(workspaceDir),
    ).not.toThrow();

    writeConfig(STRANDED_CONFIG);
    convertStrandedSubscriptionOpenaiProfilesMigration.run(workspaceDir);
    const once = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    convertStrandedSubscriptionOpenaiProfilesMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(once);
  });
});

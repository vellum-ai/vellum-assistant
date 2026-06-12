import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

// ---------------------------------------------------------------------------
// Mocks — declared before imports that depend on platform/logger
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

function ensureTestDir(): void {
  const dirs = [
    WORKSPACE_DIR,
    join(WORKSPACE_DIR, "data"),
    join(WORKSPACE_DIR, "data", "memory"),
    join(WORKSPACE_DIR, "data", "memory", "knowledge"),
    join(WORKSPACE_DIR, "data", "logs"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
    "silent",
    "child",
  ]) {
    stub[m] = m === "child" ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module("../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

// Restore all mocked modules after this file's tests complete to prevent
// cross-test contamination when running grouped with other test files.
afterAll(() => {
  mock.restore();
});

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import {
  deepMergeOverwrite,
  getConfig,
  invalidateConfigCache,
  loadConfig,
  mergeDefaultWorkspaceConfig,
} from "../config/loader.js";
import { seedInferenceProfiles } from "../config/seed-inference-profiles.js";
import type { DrizzleDb } from "../memory/db-connection.js";
import { migrateCreateProviderConnections } from "../memory/migrations/243-provider-connections.js";
import { migrateProviderConnectionStatusLabel } from "../memory/migrations/244-provider-connection-status-label.js";
import { migrateProviderConnectionBaseUrlAndModels } from "../memory/migrations/250-provider-connection-base-url-and-models.js";
import * as schema from "../memory/schema.js";
import { runProviderConnectionsBackfill } from "../providers/inference/backfill.js";
import { getConnection } from "../providers/inference/connections.js";
import { getConfigQuarantineNoticePath } from "../util/platform.js";
import { setStorePathForTesting } from "./encrypted-store-test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n");
}

function mergeDefaultConfigAndSeedInferenceProfiles(db?: DrizzleDb): void {
  const defaultConfigMerge = mergeDefaultWorkspaceConfig();
  seedInferenceProfiles({
    preserveProfileNames: defaultConfigMerge.providedLlmProfileNames,
    preserveActiveProfile: defaultConfigMerge.providedLlmActiveProfile,
    builtinProfilesWithDroppedProviderConfig:
      defaultConfigMerge.builtinProfilesWithDroppedProviderConfig,
    isHatch: defaultConfigMerge.hadOverlay,
    db,
  });
}

function createProviderConnectionsDb(): DrizzleDb {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  const db = drizzle(sqlite, { schema });
  migrateCreateProviderConnections(db);
  migrateProviderConnectionStatusLabel(db);
  migrateProviderConnectionBaseUrlAndModels(db);
  return db;
}

// ---------------------------------------------------------------------------
// Tests: deepMergeOverwrite (unit) — JSON-null-as-deletion semantics
//
// `deepMergeOverwrite` is used by `mergeDefaultWorkspaceConfig` and platform
// override paths.
// ---------------------------------------------------------------------------

describe("deepMergeOverwrite", () => {
  test("overwrites top-level scalars", () => {
    const target: Record<string, unknown> = { a: 1, b: "old" };
    deepMergeOverwrite(target, { a: 2, c: "new" });
    expect(target).toEqual({ a: 2, b: "old", c: "new" });
  });

  test("recursively merges nested objects, overwriting leaves", () => {
    const target: Record<string, unknown> = {
      nested: { keep: "yes", change: "before" },
    };
    deepMergeOverwrite(target, {
      nested: { change: "after", added: 42 },
    });
    expect(target).toEqual({
      nested: { keep: "yes", change: "after", added: 42 },
    });
  });

  test("replaces arrays wholesale rather than merging", () => {
    const target: Record<string, unknown> = { items: [1, 2, 3] };
    deepMergeOverwrite(target, { items: [9] });
    expect(target).toEqual({ items: [9] });
  });

  test("assigns null to scalar fields (preserves nullable config values)", () => {
    const target: Record<string, unknown> = { a: 1, b: 2 };
    deepMergeOverwrite(target, { a: null });
    expect(target).toEqual({ a: null, b: 2 });
    expect("a" in target).toBe(true);
  });

  test("assigns null to nested scalar fields, preserving siblings", () => {
    const target: Record<string, unknown> = {
      a: { b: 1, c: 2, d: 3 },
    };
    deepMergeOverwrite(target, { a: { b: null } });
    expect(target).toEqual({ a: { b: null, c: 2, d: 3 } });
    expect("b" in (target.a as Record<string, unknown>)).toBe(true);
  });

  test("assigns null to existing null fields (no-op for already-null)", () => {
    const target: Record<string, unknown> = {
      heartbeat: { activeHoursStart: null, intervalMs: 6000 },
    };
    deepMergeOverwrite(target, {
      heartbeat: { activeHoursStart: null },
    });
    expect(target).toEqual({
      heartbeat: { activeHoursStart: null, intervalMs: 6000 },
    });
  });

  test("deletion of a nested key whose value is itself an object", () => {
    // Models the macOS clear-call-site-override case:
    // PATCH { llm: { callSites: { commitMessage: null } } } removes the
    // commitMessage entry entirely while keeping other call-site entries
    // and unrelated llm fields intact.
    const target: Record<string, unknown> = {
      llm: {
        provider: "anthropic",
        callSites: {
          commitMessage: { provider: "openai", model: "gpt-4" },
          memoryRetrieval: { profile: "fast" },
        },
      },
    };
    deepMergeOverwrite(target, {
      llm: { callSites: { commitMessage: null } },
    });
    expect(target).toEqual({
      llm: {
        provider: "anthropic",
        callSites: {
          memoryRetrieval: { profile: "fast" },
        },
      },
    });
  });

  test("deletion is a no-op when the key is already absent", () => {
    const target: Record<string, unknown> = { a: 1 };
    deepMergeOverwrite(target, { missing: null });
    expect(target).toEqual({ a: 1 });
    expect("missing" in target).toBe(false);
  });

  test("strips null leaves when assigning a whole subtree to a missing key", () => {
    // Models a PATCH that introduces a new call-site entry while clearing
    // some of its sub-fields in the same payload — the nulls must not
    // be persisted.
    const target: Record<string, unknown> = { llm: { provider: "anthropic" } };
    deepMergeOverwrite(target, {
      llm: {
        callSites: {
          commitMessage: { provider: null, model: "gpt-4", profile: null },
        },
      },
    });
    expect(target).toEqual({
      llm: {
        provider: "anthropic",
        callSites: {
          commitMessage: { model: "gpt-4" },
        },
      },
    });
  });

  test("strips null leaves when overwriting a scalar with an object subtree", () => {
    const target: Record<string, unknown> = { a: 1 };
    deepMergeOverwrite(target, { a: { b: null, c: 5, d: { e: null, f: 6 } } });
    expect(target).toEqual({ a: { c: 5, d: { f: 6 } } });
  });

  test("nullable config fields: null replaces scalar default, not deleted", () => {
    // Models PATCH { heartbeat: { activeHoursStart: null, activeHoursEnd: null } }
    // on a config where the defaults (8, 22) are in place. The nullable fields
    // must store null (meaning "disabled") — NOT be deleted (which would
    // re-apply schema defaults on next load).
    const target: Record<string, unknown> = {
      heartbeat: { intervalMs: 6000, activeHoursStart: 8, activeHoursEnd: 22 },
    };
    deepMergeOverwrite(target, {
      heartbeat: { activeHoursStart: null, activeHoursEnd: null },
    });
    expect(target).toEqual({
      heartbeat: {
        intervalMs: 6000,
        activeHoursStart: null,
        activeHoursEnd: null,
      },
    });
  });

  test("mixed: deletes object entries, assigns null to scalars in same merge", () => {
    // Verifies both behaviors coexist in a single merge: object entries are
    // deleted (call-site clearing) while scalar nulls are assigned (nullable fields).
    const target: Record<string, unknown> = {
      llm: {
        callSites: {
          commitMessage: { provider: "openai" },
        },
      },
      heartbeat: { activeHoursStart: 8 },
    };
    deepMergeOverwrite(target, {
      llm: { callSites: { commitMessage: null } },
      heartbeat: { activeHoursStart: null },
    });
    expect(target).toEqual({
      llm: { callSites: {} },
      heartbeat: { activeHoursStart: null },
    });
  });

  test("preserves explicit boolean false and zero (not treated as null)", () => {
    const target: Record<string, unknown> = { a: true, b: 1 };
    deepMergeOverwrite(target, { a: false, b: 0 });
    expect(target).toEqual({ a: false, b: 0 });
  });

  test("undefined override values are passed through, not treated as deletion", () => {
    // JSON.parse never produces undefined, but guard the in-process call path:
    // an explicit undefined assignment should follow the same "scalar overwrite"
    // path as before, not the null-deletion path.
    const target: Record<string, unknown> = { a: 1 };
    deepMergeOverwrite(target, { a: undefined });
    expect("a" in target).toBe(true);
    expect(target.a).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: loadConfig() startup behavior
//
// Contract: disk = user intent, in-memory cache = effective values. loadConfig
// must NOT silently materialize schema defaults into config.json on load.
// The legitimate self-healing paths that DO rewrite the file (deprecated-key
// strip, fresh-config seed, corrupt-JSON quarantine) are protected below.
// ---------------------------------------------------------------------------

describe("loadConfig startup behavior", () => {
  beforeEach(() => {
    ensureTestDir();
    const resetPaths = [
      CONFIG_PATH,
      join(WORKSPACE_DIR, "default-config.json"),
      join(WORKSPACE_DIR, "hatch-overlay.json"),
      join(WORKSPACE_DIR, "keys.enc"),
      join(WORKSPACE_DIR, "data"),
      join(WORKSPACE_DIR, "data", "memory"),
    ];
    for (const path of resetPaths) {
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
    // Also clear any leftover quarantine files from previous test runs.
    if (existsSync(WORKSPACE_DIR)) {
      for (const entry of readdirSync(WORKSPACE_DIR)) {
        if (entry.startsWith("config.json.corrupt-")) {
          rmSync(join(WORKSPACE_DIR, entry), { force: true });
        }
      }
    }
    // Clear any leftover config-quarantine notice sentinel from prior runs.
    const noticePath = getConfigQuarantineNoticePath();
    if (existsSync(noticePath)) rmSync(noticePath, { force: true });
    ensureTestDir();
    setStorePathForTesting(join(WORKSPACE_DIR, "keys.enc"));
    delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
    delete process.env.IS_PLATFORM;
    invalidateConfigCache();
  });

  afterEach(() => {
    setStorePathForTesting(null);
    delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
    delete process.env.IS_PLATFORM;
    invalidateConfigCache();
  });

  test("does not modify existing config.json on load", () => {
    // Write a partial config and confirm the file's bytes are unchanged
    // after loadConfig(). Schema defaults must apply in-memory only; disk
    // is the user's source of truth.
    writeConfig({ provider: "anthropic" });
    const before = readFileSync(CONFIG_PATH);

    loadConfig();

    const after = readFileSync(CONFIG_PATH);
    expect(after.equals(before)).toBe(true);
  });

  test("getConfig().memory.v2.bm25_b returns schema default when absent on disk", () => {
    // Consumer-side correctness: even though loadConfig no longer writes
    // schema defaults back to disk, accessors still see them via the
    // in-memory `cached: AssistantConfig` populated by `applyNestedDefaults`.
    writeConfig({ provider: "anthropic" });

    const config = getConfig();

    expect(config.memory.v2.bm25_b).toBe(0.4);
  });

  test("reloads cached config when config.json is updated externally", () => {
    // Models a CLI subprocess writing twilio.accountSid while the assistant
    // process already has an effective config cached in memory.
    writeConfig({ twilio: { accountSid: "AC_cached_before" } });
    expect(loadConfig().twilio.accountSid).toBe("AC_cached_before");

    writeConfig({
      twilio: { accountSid: "AC_fresh_after_external_write" },
    });

    expect(loadConfig().twilio.accountSid).toBe(
      "AC_fresh_after_external_write",
    );
  });

  test("still strips deprecated fields and rewrites", () => {
    // `warnAndStripDeprecatedFields` is a legitimate self-healing path:
    // it removes fields the schema no longer recognizes and persists the
    // cleaned config so the deprecation warning fires only once.
    writeConfig({
      provider: "anthropic",
      rateLimit: { maxTokensPerSession: 100_000 },
    });

    loadConfig();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.rateLimit?.maxTokensPerSession).toBeUndefined();
    // Other rateLimit keys are not affected — only the deprecated entry is stripped
    expect(raw.provider).toBe("anthropic");
  });

  test("strips memory.jobs.batchSize from existing user configs", () => {
    // Pre-PR-#29364, the memory job worker read `memory.jobs.batchSize` to
    // size its single claim batch. The per-lane scheduler no longer reads
    // it, so the field is deprecated. Existing configs that have it
    // written to disk should load cleanly with the field silently stripped.
    writeConfig({
      provider: "anthropic",
      memory: { jobs: { batchSize: 25, workerConcurrency: 4 } },
    });

    loadConfig();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.memory?.jobs?.batchSize).toBeUndefined();
    // Sibling fields under memory.jobs are preserved
    expect(raw.memory?.jobs?.workerConcurrency).toBe(4);
  });

  test("still writes a default config on first launch when file is absent", () => {
    // Discoverability: when no config.json exists, write one populated with
    // all schema defaults so users can see and edit available options.
    expect(existsSync(CONFIG_PATH)).toBe(false);

    loadConfig();

    expect(existsSync(CONFIG_PATH)).toBe(true);
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    // Sanity: schema-defaulted nested fields are materialized
    expect(raw.memory?.v2?.bm25_b).toBe(0.4);
    expect(raw.dataDir).toBeUndefined();
  });

  test("off-platform hatch seeds user profiles; built-ins stay code-resolved", () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: {
              provider: "anthropic",
              model: "claude-opus-4-7",
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();
    const config = loadConfig();

    expect(config.llm.default.provider).toBe("anthropic");
    expect(config.llm.default.model).toBe("claude-opus-4-7");
    // Off-platform: user profiles are active, backed by the user's API key.
    expect(config.llm.activeProfile).toBe("custom-balanced");
    expect(config.llm.profiles["custom-balanced"]?.provider).toBe("anthropic");
    expect(config.llm.profiles["custom-balanced"]?.provider_connection).toBe(
      "anthropic-personal",
    );
    // Managed profiles exist as well (code-resolved at load time).
    expect(config.llm.profiles.balanced?.model).toBe("claude-sonnet-4-6");
    expect(config.llm.profiles.balanced?.provider_connection).toBe(
      "anthropic-managed",
    );

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.default).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(raw.llm.activeProfile).toBe("custom-balanced");
    // Built-ins are never materialized to disk; the BYOK hatch disable is
    // persisted as sparse status overrides instead.
    expect(raw.llm.profiles.balanced).toBeUndefined();
    expect(raw.llm.profileOverrides.balanced).toEqual({ status: "disabled" });
  });

  test("on-platform hatch seeds only managed profiles", () => {
    process.env.IS_PLATFORM = "true";

    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: {
              provider: "anthropic",
              model: "claude-opus-4-7",
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();
    const config = loadConfig();

    expect(config.llm.activeProfile).toBe("balanced");
    expect(config.llm.profiles.balanced?.model).toBe("claude-sonnet-4-6");
    expect(config.llm.profiles.balanced?.provider_connection).toBe(
      "anthropic-managed",
    );
    // No user profiles created on platform.
    expect(config.llm.profiles["custom-balanced"]).toBeUndefined();
  });

  test("re-hatch from openai to anthropic creates user anthropic profiles off-platform", () => {
    // Pre-seed an OpenAI-style workspace: user-defined custom-balanced profile
    // is active, default is openai. Simulates a workspace that hatched against
    // OpenAI under the pre-1.2 model.
    writeConfig({
      llm: {
        default: { provider: "openai", model: "gpt-5.4-mini" },
        profiles: {
          "custom-balanced": {
            source: "user",
            provider: "openai",
            model: "gpt-5.4-mini",
          },
        },
        activeProfile: "custom-balanced",
      },
    });

    const overlayPath = join(WORKSPACE_DIR, "rehatch-anthropic.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({ llm: { default: { provider: "anthropic" } } }, null, 2) +
        "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    // Off-platform re-hatch: user profiles are overwritten for the new
    // provider and custom-balanced becomes active.
    expect(raw.llm.activeProfile).toBe("custom-balanced");
    expect(raw.llm.profiles["custom-balanced"].provider).toBe("anthropic");
    expect(raw.llm.profiles["custom-balanced"].provider_connection).toBe(
      "anthropic-personal",
    );
    // The managed balanced profile is code-resolved, not written to disk.
    expect(raw.llm.profiles.balanced).toBeUndefined();
    const config = loadConfig();
    expect(config.llm.profiles.balanced?.provider).toBe("anthropic");
    expect(config.llm.profiles.balanced?.provider_connection).toBe(
      "anthropic-managed",
    );
  });

  test("on-platform re-hatch resets active profile to balanced", () => {
    process.env.IS_PLATFORM = "true";

    writeConfig({
      llm: {
        default: { provider: "openai", model: "gpt-5.4-mini" },
        profiles: {
          "custom-balanced": {
            source: "user",
            provider: "openai",
            model: "gpt-5.4-mini",
          },
        },
        activeProfile: "custom-balanced",
      },
    });

    const overlayPath = join(WORKSPACE_DIR, "rehatch-anthropic.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({ llm: { default: { provider: "anthropic" } } }, null, 2) +
        "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    // On-platform: no user profiles created, active resets to managed balanced.
    expect(raw.llm.activeProfile).toBe("balanced");
    // The managed balanced profile is code-resolved, not written to disk.
    expect(raw.llm.profiles.balanced).toBeUndefined();
    const config = loadConfig();
    expect(config.llm.profiles.balanced?.provider).toBe("anthropic");
    expect(config.llm.profiles.balanced?.provider_connection).toBe(
      "anthropic-managed",
    );
    // The old custom-balanced is preserved on disk but no longer active.
    expect(raw.llm.profiles["custom-balanced"].provider).toBe("openai");
  });

  test("preserves user-supplied non-catalog model on every restart (ollama custom model)", () => {
    // Models the ollama case: catalog lists only `llama3.2` but the user has
    // pulled `codellama`. The seeder must NOT silently overwrite their pick.
    writeConfig({
      llm: { default: { provider: "ollama", model: "codellama" } },
    });

    mergeDefaultConfigAndSeedInferenceProfiles();
    let raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.default.model).toBe("codellama");

    // Re-run to confirm idempotency — the user's model survives every restart.
    mergeDefaultConfigAndSeedInferenceProfiles();
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.default.model).toBe("codellama");
  });

  test("off-platform hatch with openai seeds user profiles; built-in anthropic profiles stay code-resolved", () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({ llm: { default: { provider: "openai" } } }, null, 2) +
        "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    // User profiles for the hatch provider (openai).
    expect(raw.llm.activeProfile).toBe("custom-balanced");
    expect(raw.llm.profiles["custom-balanced"].provider).toBe("openai");
    expect(raw.llm.profiles["custom-balanced"].model).toBe("gpt-5.4-mini");
    expect(raw.llm.profiles["custom-balanced"].provider_connection).toBe(
      "openai-personal",
    );
    expect(raw.llm.profiles["custom-balanced"].source).toBe("user");
    expect(raw.llm.profiles["custom-quality-optimized"].provider).toBe(
      "openai",
    );
    expect(raw.llm.profiles["custom-quality-optimized"].model).toBe("gpt-5.4");
    expect(raw.llm.profiles["custom-cost-optimized"].provider).toBe("openai");
    expect(raw.llm.profiles["custom-cost-optimized"].model).toBe(
      "gpt-5.4-nano",
    );

    // Built-in profiles are not written to disk; they are still exposed by
    // the loader (balanced uses Anthropic).
    expect(raw.llm.profiles.balanced).toBeUndefined();
    expect(raw.llm.profiles["quality-optimized"]).toBeUndefined();
    expect(raw.llm.profiles["cost-optimized"]).toBeUndefined();
    const config = loadConfig();
    expect(config.llm.profiles.balanced?.provider).toBe("anthropic");
    expect(config.llm.profiles.balanced?.provider_connection).toBe(
      "anthropic-managed",
    );
    expect(config.llm.profiles.balanced?.source).toBe("managed");
    expect(config.llm.profiles["quality-optimized"]?.provider).toBe(
      "anthropic",
    );
    expect(config.llm.profiles["cost-optimized"]?.provider).toBe("anthropic");
  });

  test("stale materialized built-in entries are left on disk; template wins in the effective config", () => {
    // Simulate a pre-migration install whose previous boots materialized
    // managed profiles into config.json. The seeder no longer touches them;
    // the loader treats the entry as transition state (template fields
    // authoritative, label/status honored) until the collapse migration
    // folds it into profileOverrides.
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            model: "old-model-from-previous-release",
            provider_connection: "anthropic-managed",
          },
        },
        activeProfile: "balanced",
      },
    });

    // Non-hatch boot (no overlay).
    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced.model).toBe(
      "old-model-from-previous-release",
    );
    expect(raw.llm.activeProfile).toBe("balanced");

    const config = loadConfig();
    expect(config.llm.profiles.balanced?.model).toBe("claude-sonnet-4-6");
    expect(config.llm.profiles.balanced?.provider_connection).toBe(
      "anthropic-managed",
    );
  });

  test("user-edited label on a stale materialized entry survives into the effective config", () => {
    // Simulate a pre-migration user who renamed the managed "balanced"
    // profile while it was still materialized on disk.
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            model: "old-model-from-previous-release",
            provider_connection: "anthropic-managed",
            label: "My Default",
          },
        },
        activeProfile: "balanced",
      },
    });

    mergeDefaultConfigAndSeedInferenceProfiles();
    const config = loadConfig();

    // The template model is authoritative (provider-controlled)…
    expect(config.llm.profiles.balanced?.model).toBe("claude-sonnet-4-6");
    // …while the user's label carries through as a transition override.
    expect(config.llm.profiles.balanced?.label).toBe("My Default");
  });

  test("user-toggled status on a stale materialized entry survives into the effective config", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            model: "old-model-from-previous-release",
            provider_connection: "anthropic-managed",
            status: "disabled",
          },
        },
        activeProfile: "balanced",
      },
    });

    mergeDefaultConfigAndSeedInferenceProfiles();
    const config = loadConfig();

    expect(config.llm.profiles.balanced?.status).toBe("disabled");
    // Model still resolves from the template — only label/status are
    // user-owned.
    expect(config.llm.profiles.balanced?.model).toBe("claude-sonnet-4-6");
  });

  test("boot leaves an explicit null label on a stale materialized entry untouched", () => {
    // Setting label to null is the "clear" intent — the seeder must not
    // rewrite or remove the stale entry on boot.
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            model: "old-model",
            provider_connection: "anthropic-managed",
            label: null,
          },
        },
        activeProfile: "balanced",
      },
    });

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced.label).toBeNull();
  });

  test("first boot writes no built-in entries; BYOK label suffix comes from the loader", () => {
    // First boot, no prior config — nothing is materialized. Off-platform
    // installs get the " (Managed)" suffix on the code-resolved entries so
    // the managed profile is distinguishable from the personal "custom-*"
    // sibling that shares the base label.
    writeConfig({});

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles).toEqual({});
    expect(raw.llm.profileOverrides).toBeUndefined();

    const config = loadConfig();
    expect(config.llm.profiles.balanced?.label).toBe("Balanced (Managed)");
    expect(config.llm.profiles.balanced?.model).toBe("claude-sonnet-4-6");
    // Status is unset by default (non-hatch boot writes no overrides).
    expect(config.llm.profiles.balanced?.status).toBeUndefined();
  });

  test("platform overlay built-in fragments convert to profileOverrides", () => {
    process.env.IS_PLATFORM = "true";

    writeConfig({
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-opus-4-7",
        },
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            maxTokens: 16000,
            effort: "high",
            thinking: { enabled: true, streamThinking: true },
          },
        },
        activeProfile: "balanced",
      },
    });

    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: {
              provider: "openai",
              model: "gpt-5.4",
            },
            profiles: {
              balanced: {
                source: "managed",
                provider: "openai",
                model: "gpt-5.4",
                label: "Platform Balanced",
              },
            },
            activeProfile: "balanced",
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();
    const config = loadConfig();
    const mainAgentConfig = resolveCallSiteConfig("mainAgent", config.llm);

    expect(config.llm.activeProfile).toBe("balanced");
    // Built-in profiles are code-resolved at load time: the template's
    // config fields are authoritative in the *effective* config, while the
    // overlay fragment contributes only its user-ownable facets, lifted into
    // `llm.profileOverrides` at merge time (non-override fields dropped).
    expect(config.llm.profiles.balanced!.label).toBe("Platform Balanced");
    expect(config.llm.profiles.balanced!.provider).toBe("anthropic");
    expect(config.llm.profiles.balanced!.model).toBe("claude-sonnet-4-6");
    expect(mainAgentConfig.provider).toBe("anthropic");
    expect(mainAgentConfig.model).toBe("claude-sonnet-4-6");

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    // The overlay entry never lands in llm.profiles — and the pre-existing
    // materialized entry was removed rather than left behind as a shadow.
    expect(raw.llm.profiles.balanced).toBeUndefined();
    expect(raw.llm.profileOverrides.balanced).toEqual({
      label: "Platform Balanced",
    });

    mergeDefaultConfigAndSeedInferenceProfiles();

    const afterRestart = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(afterRestart.llm.activeProfile).toBe("balanced");
    expect(afterRestart.llm.profiles.balanced).toBeUndefined();
    expect(afterRestart.llm.profileOverrides.balanced).toEqual({
      label: "Platform Balanced",
    });
  });

  test("quarantines corrupt config before merging hatch overlay", () => {
    writeFileSync(CONFIG_PATH, "{not valid json");

    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: {
              provider: "anthropic",
              model: "claude-opus-4-7",
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();

    const quarantined = readdirSync(WORKSPACE_DIR).filter((n) =>
      n.startsWith("config.json.corrupt-"),
    );
    expect(quarantined.length).toBeGreaterThan(0);

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.default).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    // Off-platform hatch: user profiles are active; built-ins are not
    // materialized.
    expect(raw.llm.activeProfile).toBe("custom-balanced");
    expect(raw.llm.profiles["custom-balanced"].provider).toBe("anthropic");
    expect(raw.llm.profiles.balanced).toBeUndefined();
    expect(loadConfig().llm.profiles.balanced?.model).toBe("claude-sonnet-4-6");
  });

  test("still quarantines corrupt JSON", () => {
    // Corrupt-config quarantine is a recovery path: the broken file is
    // renamed to `config.json.corrupt-<ts>.json` and the daemon proceeds
    // with defaults. This must keep working.
    writeFileSync(CONFIG_PATH, "{not valid json");

    loadConfig();

    // A new defaults-populated config.json is written in place
    expect(existsSync(CONFIG_PATH)).toBe(true);
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.memory?.v2?.bm25_b).toBe(0.4);

    // The corrupt original is preserved as a `*.corrupt-*.json` sibling
    const quarantined = readdirSync(WORKSPACE_DIR).filter((n) =>
      n.startsWith("config.json.corrupt-"),
    );
    expect(quarantined.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: BYOK-mode behavior. Off-platform built-in profiles share base labels
// with the personal "custom-*" profiles (Balanced / Quality / Speed), so the
// loader's code-resolved entries carry a " (Managed)" suffix to disambiguate.
// Status is set to "disabled" via sparse `llm.profileOverrides` entries ONLY
// at hatch — a fresh BYOK user has no platform auth, so built-ins must not
// surface as enabled in the picker on day one. Post-hatch user toggles
// persist through every subsequent boot — the "never auto-disable BYOK
// connections" rule applies to RESTART, not to hatch. On-platform behavior
// is unchanged.
// ---------------------------------------------------------------------------

describe("seedInferenceProfiles BYOK-mode built-in profile handling", () => {
  beforeEach(() => {
    ensureTestDir();
    const resetPaths = [
      CONFIG_PATH,
      join(WORKSPACE_DIR, "default-config.json"),
      join(WORKSPACE_DIR, "hatch-overlay.json"),
      join(WORKSPACE_DIR, "keys.enc"),
      join(WORKSPACE_DIR, "data"),
      join(WORKSPACE_DIR, "data", "memory"),
    ];
    for (const path of resetPaths) {
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
    ensureTestDir();
    setStorePathForTesting(join(WORKSPACE_DIR, "keys.enc"));
    delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
    delete process.env.IS_PLATFORM;
    invalidateConfigCache();
  });

  afterEach(() => {
    setStorePathForTesting(null);
    delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
    delete process.env.IS_PLATFORM;
    invalidateConfigCache();
  });

  test("off-platform hatch suffixes managed profile labels with ' (Managed)'", () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: { provider: "anthropic", model: "claude-opus-4-7" },
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();
    const config = loadConfig();

    // Managed profile labels carry the suffix so they're visibly distinct
    // from the personal "custom-*" profiles (which retain bare labels).
    expect(config.llm.profiles.balanced?.label).toBe("Balanced (Managed)");
    expect(config.llm.profiles["quality-optimized"]?.label).toBe(
      "Quality (Managed)",
    );
    expect(config.llm.profiles["cost-optimized"]?.label).toBe(
      "Speed (Managed)",
    );

    // Personal profiles keep their bare labels — they're the daily driver.
    expect(config.llm.profiles["custom-balanced"]?.label).toBe("Balanced");
  });

  test("off-platform hatch initializes built-in profile status to 'disabled' via profileOverrides", () => {
    // On a fresh BYOK hatch the user has no platform auth, so built-in
    // profiles must not surface as enabled in the picker on day one. The
    // disable is persisted ONCE at hatch time as sparse status overrides —
    // never as materialized profile entries. (The complementary "user
    // re-enable persists across restarts" guarantee is covered by the test
    // further down.)
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({ llm: { default: { provider: "anthropic" } } }, null, 2) +
        "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();
    const config = loadConfig();

    expect(config.llm.profiles.balanced?.status).toBe("disabled");
    expect(config.llm.profiles["quality-optimized"]?.status).toBe("disabled");
    expect(config.llm.profiles["cost-optimized"]?.status).toBe("disabled");

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    // Only the hatch-time custom profiles are materialized on disk.
    expect(Object.keys(raw.llm.profiles).sort()).toEqual([
      "custom-balanced",
      "custom-cost-optimized",
      "custom-quality-optimized",
    ]);
    expect(raw.llm.profileOverrides.balanced).toEqual({ status: "disabled" });
    expect(raw.llm.profileOverrides["quality-optimized"]).toEqual({
      status: "disabled",
    });
    expect(raw.llm.profileOverrides["cost-optimized"]).toEqual({
      status: "disabled",
    });
    // Flag-gated built-ins get the override too, regardless of flag state —
    // harmless while the flag is off, correct if it later enables.
    expect(raw.llm.profileOverrides["balanced-economy"]).toEqual({
      status: "disabled",
    });
  });

  test("off-platform managed-inference hatch keeps selected managed connection active", () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: { provider: "anthropic" },
            activeProfile: "balanced",
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;
    const db = createProviderConnectionsDb();

    mergeDefaultConfigAndSeedInferenceProfiles(db);
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.activeProfile).toBe("balanced");
    expect(raw.llm.profiles.balanced).toBeUndefined();
    // The hatch-selected connection (anthropic-managed, resolved from the
    // balanced template) keeps the profiles sharing it enabled; only the
    // built-ins on other managed connections get a status override.
    expect(raw.llm.profileOverrides?.balanced).toBeUndefined();
    expect(raw.llm.profileOverrides?.["quality-optimized"]).toBeUndefined();
    expect(raw.llm.profileOverrides?.["cost-optimized"]).toBeUndefined();
    expect(raw.llm.profileOverrides?.["balanced-economy"]).toEqual({
      status: "disabled",
    });

    const config = loadConfig();
    expect(config.llm.profiles.balanced?.provider_connection).toBe(
      "anthropic-managed",
    );
    expect(config.llm.profiles.balanced?.status).toBeUndefined();
    // Connections exist (status is no longer a connection-level concept).
    expect(getConnection(db, "anthropic-managed")).not.toBeNull();
    expect(getConnection(db, "openai-managed")).not.toBeNull();
    expect(getConnection(db, "gemini-managed")).not.toBeNull();
  });

  test("hatch overlay built-in entry converts to profileOverrides, dropping non-override fields", () => {
    // An overlay supplying a full `balanced` entry must not produce a shadow
    // entry in llm.profiles: label/status are lifted into profileOverrides
    // and everything else (provider/connection/model) is dropped — the code
    // template is authoritative for built-in profile config. Because the
    // dropped fields carried provider routing, the activeProfile naming the
    // built-in did not select the managed route: it remaps to the personal
    // custom profile backed by the hatch connection.
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: { provider: "anthropic" },
            profiles: {
              balanced: {
                source: "managed",
                provider: "anthropic",
                provider_connection: "anthropic-personal",
                model: "claude-sonnet-4-6",
                label: "Hatch Balanced",
              },
            },
            activeProfile: "balanced",
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;
    const db = createProviderConnectionsDb();

    mergeDefaultConfigAndSeedInferenceProfiles(db);
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.activeProfile).toBe("custom-balanced");
    expect(raw.llm.profiles.balanced).toBeUndefined();
    // No managed connection was genuinely selected, so the managed built-in
    // gets the hatch-disable status alongside the lifted overlay label.
    expect(raw.llm.profileOverrides.balanced).toEqual({
      label: "Hatch Balanced",
      status: "disabled",
    });

    // Connection routing comes from the template, not the dropped overlay
    // field.
    const config = loadConfig();
    expect(config.llm.profiles.balanced?.provider_connection).toBe(
      "anthropic-managed",
    );
    expect(config.llm.profiles.balanced?.label).toBe("Hatch Balanced");
    expect(config.llm.profiles["custom-balanced"]?.provider_connection).toBe(
      "anthropic-personal",
    );
    expect(getConnection(db, "anthropic-managed")).not.toBeNull();
    expect(getConnection(db, "anthropic-personal")).not.toBeNull();
  });

  test("explicit overlay profileOverrides win over lifted legacy fragment fields", () => {
    // When an overlay carries both representations for a built-in — a legacy
    // `llm.profiles` fragment and an explicit `llm.profileOverrides` entry —
    // the explicit override is canonical: lifted legacy fields only fill
    // keys the explicit entry does not set.
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            profiles: {
              balanced: { label: "Legacy Label", status: "disabled" },
            },
            profileOverrides: {
              balanced: { label: "Explicit Label" },
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.profiles?.balanced).toBeUndefined();
    expect(raw.llm.profileOverrides.balanced).toEqual({
      label: "Explicit Label",
      status: "disabled",
    });
  });

  test("seed-default label in overlay built-in fragment is not lifted into profileOverrides", () => {
    // The bare template label is a seeder artifact in legacy fragments, not
    // overlay intent. Lifting it would pin the label as an override and
    // bypass the resolve-time default — on BYOK that default carries the
    // " (Managed)" suffix.
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: { provider: "anthropic" },
            profiles: {
              balanced: {
                provider: "anthropic",
                model: "claude-sonnet-4-6",
                label: "Balanced",
              },
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.profiles?.balanced).toBeUndefined();
    expect(raw.llm.profileOverrides.balanced).toEqual({ status: "disabled" });

    const config = loadConfig();
    expect(config.llm.profiles.balanced?.label).toBe("Balanced (Managed)");
  });

  test("' (Managed)'-suffixed seed-default label in overlay built-in fragment is not lifted either", () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: { provider: "anthropic" },
            profiles: {
              balanced: { label: "Balanced (Managed)" },
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.profileOverrides.balanced).toEqual({ status: "disabled" });
  });

  test("non-seed-default label in overlay built-in fragment still lifts into profileOverrides", () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: { provider: "anthropic" },
            profiles: {
              balanced: { label: "My Org Default" },
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.profileOverrides.balanced).toEqual({
      label: "My Org Default",
      status: "disabled",
    });

    const config = loadConfig();
    expect(config.llm.profiles.balanced?.label).toBe("My Org Default");
  });

  test("explicit overlay profileOverrides label matching the seed default persists — the filter applies only to lifted legacy fragments", () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: { provider: "anthropic" },
            profileOverrides: {
              balanced: { label: "Balanced" },
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.profileOverrides.balanced).toEqual({
      label: "Balanced",
      status: "disabled",
    });

    const config = loadConfig();
    expect(config.llm.profiles.balanced?.label).toBe("Balanced");
  });

  test("explicit overlay profileOverrides label null survives a first-hatch merge and masks a stale materialized label", () => {
    // First-hatch shape: the on-disk config has no `profileOverrides` subtree
    // yet, only a pre-migration materialized `balanced` entry carrying a
    // custom label. The overlay's explicit `label: null` is the clear
    // sentinel — it must persist through the merge (not be stripped as a
    // null leaf) so it masks the stale label at resolve time.
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            model: "old-model-from-previous-release",
            provider_connection: "anthropic-managed",
            label: "Stale Custom Label",
          },
        },
        activeProfile: "balanced",
      },
    });

    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: { provider: "anthropic" },
            profileOverrides: {
              balanced: { label: null },
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    // The null sentinel persisted; the BYOK hatch disable joins it.
    expect(raw.llm.profileOverrides.balanced).toEqual({
      label: null,
      status: "disabled",
    });

    const config = loadConfig();
    expect(config.llm.profiles.balanced?.label).toBeNull();
  });

  test("explicit overlay profileOverrides status null survives a first-hatch merge and masks a stale materialized status", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            model: "old-model-from-previous-release",
            provider_connection: "anthropic-managed",
            status: "disabled",
          },
        },
        activeProfile: "balanced",
      },
    });

    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: { provider: "anthropic" },
            profileOverrides: {
              balanced: { status: null },
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    // The seeder's hatch disable never clobbers an existing status key, so
    // the explicit null clear is what lands on disk.
    expect(raw.llm.profileOverrides.balanced).toEqual({ status: null });

    const config = loadConfig();
    expect(config.llm.profiles.balanced?.status).toBeNull();
  });

  test("hatch overlay activeProfile naming a built-in with dropped provider routing remaps to the matching custom profile", () => {
    // Pre-PR semantics let a hatch overlay back `balanced` with openai; that
    // representation no longer exists. The hatch collected an openai BYOK
    // key (CLI seeds llm.default.provider from the active profile body), so
    // booting active on the code-defined managed Anthropic `balanced` would
    // break first-run routing/auth. The nearest equivalent is the personal
    // custom profile with the same intent.
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: { provider: "openai" },
            profiles: {
              balanced: { provider: "openai", label: "My Balanced" },
            },
            activeProfile: "balanced",
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;
    const db = createProviderConnectionsDb();

    mergeDefaultConfigAndSeedInferenceProfiles(db);
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.activeProfile).toBe("custom-balanced");
    // No built-in entries are materialized into llm.profiles.
    expect(Object.keys(raw.llm.profiles).sort()).toEqual([
      "custom-balanced",
      "custom-cost-optimized",
      "custom-quality-optimized",
    ]);
    // No managed connection was genuinely selected, so every managed
    // profile gets the hatch-disable override; the overlay label is still
    // lifted into the override store.
    expect(raw.llm.profileOverrides.balanced).toEqual({
      label: "My Balanced",
      status: "disabled",
    });
    expect(raw.llm.profileOverrides["quality-optimized"]).toEqual({
      status: "disabled",
    });
    expect(raw.llm.profileOverrides["cost-optimized"]).toEqual({
      status: "disabled",
    });
    expect(raw.llm.profileOverrides["balanced-economy"]).toEqual({
      status: "disabled",
    });

    const config = loadConfig();
    expect(config.llm.profiles["custom-balanced"]?.provider).toBe("openai");
    expect(config.llm.profiles["custom-balanced"]?.provider_connection).toBe(
      "openai-personal",
    );
    expect(getConnection(db, "openai-personal")).not.toBeNull();
  });

  test("hatch overlay activeProfile=quality-optimized with dropped gemini routing remaps by intent", () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: { provider: "gemini" },
            profiles: {
              "quality-optimized": { provider: "gemini" },
            },
            activeProfile: "quality-optimized",
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;
    const db = createProviderConnectionsDb();

    mergeDefaultConfigAndSeedInferenceProfiles(db);
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.activeProfile).toBe("custom-quality-optimized");
    expect(raw.llm.profileOverrides["quality-optimized"]).toEqual({
      status: "disabled",
    });

    const config = loadConfig();
    expect(
      config.llm.profiles["custom-quality-optimized"]?.provider_connection,
    ).toBe("gemini-personal");
    expect(getConnection(db, "gemini-personal")).not.toBeNull();
  });

  test("ollama hatch overlay built-in routing transplants to custom-balanced instead of dropping", () => {
    // Ollama never gets a hatch personal connection from the seeder (it is
    // keyless), so the seeder's activeProfile remap can't repair a dropped
    // routing. The merge transplants the full entry onto the custom name
    // and the post-seed backfill derives the keyless connection, keeping
    // first-run dispatch on the provider the hatch selected. The CLI emits
    // no llm.default for ollama hatches (resolveHatchProvider returns null),
    // so the overlay carries only the profile fragment + activeProfile.
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            profiles: {
              balanced: { provider: "ollama", model: "llama3.2" },
            },
            activeProfile: "balanced",
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;
    const db = createProviderConnectionsDb();

    mergeDefaultConfigAndSeedInferenceProfiles(db);
    // Lifecycle re-runs the backfill after hatch seeding because the boot
    // backfill runs before the overlay merge; mirror that ordering.
    runProviderConnectionsBackfill(db);

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.activeProfile).toBe("custom-balanced");
    // The transplanted entry is the only materialized profile — no built-in
    // names on disk, and no hatch personal-connection profile set (those are
    // gated on an api-key provider in llm.default).
    expect(Object.keys(raw.llm.profiles)).toEqual(["custom-balanced"]);
    expect(raw.llm.profiles["custom-balanced"]).toEqual({
      provider: "ollama",
      model: "llama3.2",
      source: "user",
      provider_connection: "ollama-personal",
    });
    // No managed connection was genuinely selected, so every managed
    // built-in gets the hatch-disable override.
    expect(raw.llm.profileOverrides.balanced).toEqual({ status: "disabled" });
    expect(raw.llm.profileOverrides["quality-optimized"]).toEqual({
      status: "disabled",
    });
    expect(raw.llm.profileOverrides["cost-optimized"]).toEqual({
      status: "disabled",
    });
    expect(raw.llm.profileOverrides["balanced-economy"]).toEqual({
      status: "disabled",
    });

    const connection = getConnection(db, "ollama-personal");
    expect(connection?.provider).toBe("ollama");
    expect(connection?.auth).toEqual({ type: "none" });

    const config = loadConfig();
    expect(config.llm.activeProfile).toBe("custom-balanced");
    const resolved = resolveCallSiteConfig("mainAgent", config.llm);
    expect(resolved.provider).toBe("ollama");
    expect(resolved.model).toBe("llama3.2");
    expect(resolved.provider_connection).toBe("ollama-personal");
  });

  test("balanced-economy ollama routing transplants by intent to custom-balanced", () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            profiles: {
              "balanced-economy": { provider: "ollama", model: "qwen3" },
            },
            activeProfile: "balanced-economy",
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;
    const db = createProviderConnectionsDb();

    mergeDefaultConfigAndSeedInferenceProfiles(db);

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.activeProfile).toBe("custom-balanced");
    expect(raw.llm.profiles["custom-balanced"]).toEqual({
      provider: "ollama",
      model: "qwen3",
      source: "user",
    });
    expect(raw.llm.profiles["balanced-economy"]).toBeUndefined();
    expect(raw.llm.profileOverrides["balanced-economy"]).toEqual({
      status: "disabled",
    });
  });

  test("openai-compatible hatch overlay routing transplants; explicit connection preserved, none derived", () => {
    // openai-compatible connections require per-connection base_url/models,
    // so neither the seeder nor the backfill can derive one from a bare
    // provider id. The transplant still preserves the overlay's routing
    // intent on disk: an explicit provider_connection carries through
    // untouched, and an entry without one keeps its provider/model (the
    // backfill logs a skip) instead of silently rerouting to the managed
    // Anthropic template.
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            profiles: {
              balanced: {
                provider: "openai-compatible",
                model: "my-model",
                provider_connection: "my-endpoint",
              },
              "quality-optimized": {
                provider: "openai-compatible",
                model: "my-big-model",
              },
            },
            activeProfile: "balanced",
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;
    const db = createProviderConnectionsDb();

    mergeDefaultConfigAndSeedInferenceProfiles(db);
    runProviderConnectionsBackfill(db);

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.activeProfile).toBe("custom-balanced");
    expect(raw.llm.profiles["custom-balanced"]).toEqual({
      provider: "openai-compatible",
      model: "my-model",
      provider_connection: "my-endpoint",
      source: "user",
    });
    expect(raw.llm.profiles["custom-quality-optimized"]).toEqual({
      provider: "openai-compatible",
      model: "my-big-model",
      source: "user",
    });
    expect(raw.llm.profiles.balanced).toBeUndefined();
    expect(raw.llm.profiles["quality-optimized"]).toBeUndefined();
    expect(raw.llm.profileOverrides.balanced).toEqual({ status: "disabled" });
  });

  test("explicit overlay custom-* entry wins over a transplant of the same name", () => {
    // When the overlay supplies both representations the explicit custom
    // entry is authoritative; the built-in's routing falls back to the
    // drop-and-track conversion.
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            profiles: {
              balanced: { provider: "ollama", model: "llama3.2" },
              "custom-balanced": { provider: "ollama", model: "qwen3" },
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;
    const db = createProviderConnectionsDb();

    mergeDefaultConfigAndSeedInferenceProfiles(db);

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.profiles["custom-balanced"].model).toBe("qwen3");
    expect(raw.llm.profiles.balanced).toBeUndefined();
  });

  test("hatch overlay activeProfile naming a built-in with a label-only body stays preserved", () => {
    // A label-only fragment carries no provider routing, so the overlay
    // genuinely selected the managed route: the built-in name is preserved
    // as active and its managed connection's profiles stay enabled.
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: { provider: "anthropic" },
            profiles: {
              balanced: { label: "Renamed Balanced" },
            },
            activeProfile: "balanced",
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;
    const db = createProviderConnectionsDb();

    mergeDefaultConfigAndSeedInferenceProfiles(db);
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.activeProfile).toBe("balanced");
    expect(raw.llm.profiles.balanced).toBeUndefined();
    // Profiles sharing the hatch-selected anthropic-managed connection stay
    // enabled; only built-ins on other managed connections are disabled.
    expect(raw.llm.profileOverrides.balanced).toEqual({
      label: "Renamed Balanced",
    });
    expect(raw.llm.profileOverrides["quality-optimized"]).toBeUndefined();
    expect(raw.llm.profileOverrides["cost-optimized"]).toBeUndefined();
    expect(raw.llm.profileOverrides["balanced-economy"]).toEqual({
      status: "disabled",
    });

    const config = loadConfig();
    expect(config.llm.profiles.balanced?.label).toBe("Renamed Balanced");
    expect(config.llm.profiles.balanced?.status).toBeUndefined();
  });

  test("non-hatch off-platform boot does NOT auto-disable built-in profiles", () => {
    // Existing installs that upgrade must not have built-ins auto-disabled
    // on a normal boot. The hatch-time disable is gated on `isHatch`;
    // without an overlay there's no hatch signal, so no status overrides
    // are written (schema default = "active"). This is the "we never want
    // to auto-disable BYOK connections on restart" guarantee.
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
      },
    });

    // No overlay → not a hatch.
    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profileOverrides).toBeUndefined();

    const config = loadConfig();
    expect(config.llm.profiles.balanced?.status).toBeUndefined();
    expect(config.llm.profiles["quality-optimized"]?.status).toBeUndefined();
    expect(config.llm.profiles["cost-optimized"]?.status).toBeUndefined();
  });

  test("on-platform hatch leaves managed labels untouched", () => {
    process.env.IS_PLATFORM = "true";

    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({ llm: { default: { provider: "anthropic" } } }, null, 2) +
        "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();
    const config = loadConfig();

    // No "(Managed)" suffix on platform — the personal profiles don't exist
    // here so there's nothing to disambiguate from.
    expect(config.llm.profiles.balanced?.label).toBe("Balanced");
    expect(config.llm.profiles["quality-optimized"]?.label).toBe("Quality");
    expect(config.llm.profiles["cost-optimized"]?.label).toBe("Speed");
  });

  test("stale bare labels on materialized entries are seed artifacts: the BYOK suffix default applies", () => {
    // Existing off-platform install (pre-suffix era) has `label: "Balanced"`
    // on disk. A seed-default label is not user intent, so the loader skips
    // it when lifting transition overrides — the resolve-time " (Managed)"
    // suffix applies and the managed profile stays distinguishable from the
    // personal `custom-*` sibling sharing the bare label.
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-sonnet-4-6",
            label: "Balanced",
          },
          "quality-optimized": {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            label: "Quality",
          },
          "cost-optimized": {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            label: "Speed",
          },
        },
        activeProfile: "balanced",
      },
    });

    // No overlay → not a hatch. The seeder leaves the stale entries alone.
    mergeDefaultConfigAndSeedInferenceProfiles();
    const config = loadConfig();

    expect(config.llm.profiles.balanced?.label).toBe("Balanced (Managed)");
    expect(config.llm.profiles["quality-optimized"]?.label).toBe(
      "Quality (Managed)",
    );
    expect(config.llm.profiles["cost-optimized"]?.label).toBe(
      "Speed (Managed)",
    );
  });

  test("upgrade boot preserves user-customized labels and explicit null on off-platform", () => {
    // The seeder never rewrites stale materialized entries: a user-set
    // string and an explicit null (user cleared the label) stay on disk
    // verbatim. Seed-default labels stay on disk too — the loader skips
    // them at read time instead of migrating them here.
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-sonnet-4-6",
            label: "My Balanced",
          },
          "quality-optimized": {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            label: null,
          },
          // Seed-default suffixed labels stay on disk; the loader treats
          // them as seed artifacts at read time.
          "cost-optimized": {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            label: "Speed (Managed)",
          },
        },
        activeProfile: "balanced",
      },
    });

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced.label).toBe("My Balanced");
    expect(raw.llm.profiles["quality-optimized"].label).toBeNull();
    expect(raw.llm.profiles["cost-optimized"].label).toBe("Speed (Managed)");
  });

  test("upgrade boot keeps the bare label on platform", () => {
    // A stale bare "Balanced" label is a seed artifact and is skipped as an
    // override; on platform the resolve-time default is the bare label, so
    // the effective label is unchanged (no suffix on platform).
    process.env.IS_PLATFORM = "true";
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-sonnet-4-6",
            label: "Balanced",
          },
        },
        activeProfile: "balanced",
      },
    });

    mergeDefaultConfigAndSeedInferenceProfiles();
    const config = loadConfig();

    expect(config.llm.profiles.balanced?.label).toBe("Balanced");
  });

  test("subsequent off-platform boot preserves user-set status on managed profiles", () => {
    // Simulate a user who hatched yesterday, then re-enabled the managed
    // Balanced profile (they have platform auth via a separate route).
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-sonnet-4-6",
            label: "Balanced (Managed)",
            status: "active",
          },
          "custom-balanced": {
            source: "user",
            provider: "anthropic",
            provider_connection: "anthropic-personal",
            model: "claude-sonnet-4-6",
            label: "Balanced",
          },
        },
        activeProfile: "balanced",
      },
    });

    // No overlay → this is a normal boot, not a hatch.
    mergeDefaultConfigAndSeedInferenceProfiles();
    const config = loadConfig();

    // User's "active" decision survives the boot upsert.
    expect(config.llm.profiles.balanced?.status).toBe("active");
    // Label is still suffixed (Vellum can push label updates).
    expect(config.llm.profiles.balanced?.label).toBe("Balanced (Managed)");
  });
});

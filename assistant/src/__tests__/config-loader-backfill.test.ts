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

import {
  getEffectiveProfile,
  getEffectiveProfiles,
  MANAGED_PROFILE_NAMES,
  materializeProfile,
  OS_BETA_PROFILE_TEMPLATE,
} from "../config/default-profile-catalog.js";
import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import {
  deepMergeOverwrite,
  getConfig,
  invalidateConfigCache,
  loadConfig,
  mergeDefaultWorkspaceConfig,
} from "../config/loader.js";
import { seedInferenceProfiles } from "../config/seed-inference-profiles.js";
import type { DrizzleDb } from "../persistence/db-connection.js";
import { migrateCreateProviderConnections } from "../persistence/migrations/243-provider-connections.js";
import { migrateProviderConnectionStatusLabel } from "../persistence/migrations/244-provider-connection-status-label.js";
import { migrateProviderConnectionBaseUrlAndModels } from "../persistence/migrations/250-provider-connection-base-url-and-models.js";
import * as schema from "../persistence/schema/index.js";
import { getConnection } from "../providers/inference/connections.js";
import { getConfigQuarantineNoticePath } from "../util/platform.js";
import { setStorePathForTesting } from "./encrypted-store-test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n");
}

function latencySeed(): Record<string, unknown> {
  return {
    model: "claude-haiku-4-5-20251001",
    effort: "low",
    thinking: { enabled: false },
  };
}

function fullSeededCallSites(): Record<string, Record<string, unknown>> {
  return {
    guardianQuestionCopy: latencySeed(),
    interactionClassifier: latencySeed(),
    skillCategoryInference: latencySeed(),
    inviteInstructionGenerator: latencySeed(),
    notificationDecision: latencySeed(),
    preferenceExtraction: latencySeed(),
    commitMessage: {
      model: "claude-haiku-4-5-20251001",
      maxTokens: 120,
      temperature: 0.2,
      effort: "low",
      thinking: { enabled: false },
    },
    conversationStarters: latencySeed(),
    conversationSummarization: {
      model: "claude-opus-4-7",
      effort: "low",
      thinking: { enabled: false },
    },
    recall: {
      profile: "cost-optimized",
      maxTokens: 4096,
      effort: "low",
      thinking: { enabled: false, streamThinking: false },
      temperature: 0,
      disableCache: true,
    },
    heartbeatAgent: {
      profile: "cost-optimized",
      maxTokens: 2048,
      effort: "low",
      temperature: 0,
      thinking: { enabled: false, streamThinking: false },
      contextWindow: { maxInputTokens: 16000 },
    },
    replySuggestion: {
      model: "claude-haiku-4-5-20251001",
      effort: "low",
      thinking: { enabled: false },
      disableCache: true,
    },
    memoryRouter: {
      profile: "cost-optimized",
      contextWindow: { maxInputTokens: 1_000_000 },
    },
  };
}

function mergeDefaultConfigAndSeedInferenceProfiles(db?: DrizzleDb): void {
  const defaultConfigMerge = mergeDefaultWorkspaceConfig();
  seedInferenceProfiles({
    preserveProfileNames: defaultConfigMerge.providedLlmProfileNames,
    preserveActiveProfile: defaultConfigMerge.providedLlmActiveProfile,
    isHatch: defaultConfigMerge.hadOverlay,
    db,
  });
}

/**
 * The exact thin stub `seedInferenceProfiles` writes for a default profile on
 * a fresh BYOK hatch: no content fields, only the workspace-owned overlays.
 */
function managedStub(label: string): Record<string, unknown> {
  return { source: "managed", status: "disabled", label: `${label} (Managed)` };
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

  test("default workspace config merge prunes exact seeded call-site defaults", () => {
    const seededCallSites = fullSeededCallSites();
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          gateway: {
            unmappedPolicy: "default",
            defaultAssistantId: "self",
          },
          llm: {
            activeProfile: "balanced",
            advisorProfile: "frontier",
            callSites: {
              ...seededCallSites,
              recall: {
                ...seededCallSites.recall,
                disableCache: false,
              },
              customSite: { profile: "frontier" },
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    const result = mergeDefaultWorkspaceConfig();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<
      string,
      Record<string, unknown>
    >;
    const llm = raw.llm as Record<string, unknown>;
    const callSites = llm.callSites as Record<string, Record<string, unknown>>;

    expect(result.hadOverlay).toBe(true);
    expect(raw.gateway).toEqual({
      unmappedPolicy: "default",
      defaultAssistantId: "self",
    });
    expect(llm.activeProfile).toBe("balanced");
    expect(llm.advisorProfile).toBe("frontier");
    expect(Object.keys(callSites).sort()).toEqual(["customSite", "recall"]);
    expect(callSites.recall?.disableCache).toBe(false);
    expect(callSites.customSite).toEqual({ profile: "frontier" });
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

  test("strips daemon.reapOrphanedSubprocesses from existing user configs", () => {
    // `daemon.reapOrphanedSubprocesses` is a deprecated opt-in flag: the
    // orphan-subprocess reaper runs by default whenever the daemon is PID 1 on
    // Linux. Existing configs that have it written to disk should load cleanly
    // with the field silently stripped.
    writeConfig({
      provider: "anthropic",
      daemon: { reapOrphanedSubprocesses: true, standaloneRecording: false },
    });

    loadConfig();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.daemon?.reapOrphanedSubprocesses).toBeUndefined();
    // Sibling fields under daemon are preserved
    expect(raw.daemon?.standaloneRecording).toBe(false);
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

  test("off-platform hatch seeds user anthropic profiles and thin managed stubs", () => {
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

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.default).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(raw.llm.activeProfile).toBe("custom-balanced");
    // The managed defaults exist only as thin disabled stubs — their content
    // is code-owned and never written to the workspace.
    expect(raw.llm.profiles.balanced).toEqual(managedStub("Balanced"));
    // Default content resolves from the code catalog via the effective view.
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.model).toBe("accounts/fireworks/models/glm-5p2");
    expect(effectiveBalanced?.provider).toBe("fireworks");
    expect(effectiveBalanced?.provider_connection).toBe("vellum");
  });

  test("on-platform hatch writes no profile entries; defaults resolve from the catalog", () => {
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
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.activeProfile).toBe("balanced");
    expect(raw.llm.advisorProfile).toBe("quality-optimized");
    // Platform installs materialize no managed entries and no user profiles —
    // llm.profiles holds only user/custom entries (none here).
    expect(raw.llm.profiles).toEqual({});
    // Default content resolves from the code catalog via the effective view.
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.model).toBe("accounts/fireworks/models/glm-5p2");
    expect(effectiveBalanced?.provider).toBe("fireworks");
    expect(effectiveBalanced?.provider_connection).toBe("vellum");
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
    // The managed defaults get only thin disabled stubs; content stays
    // code-owned and resolves from the catalog.
    expect(raw.llm.profiles.balanced).toEqual(managedStub("Balanced"));
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.provider).toBe("fireworks");
    expect(effectiveBalanced?.provider_connection).toBe("vellum");
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
    // No managed entry is materialized; content resolves from the catalog.
    expect(raw.llm.profiles.balanced).toBeUndefined();
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.provider).toBe("fireworks");
    expect(effectiveBalanced?.provider_connection).toBe("vellum");
    // The old custom-balanced is preserved on disk but no longer active.
    expect(raw.llm.profiles["custom-balanced"].provider).toBe("openai");
  });

  test("hatch overlay active profile must be dispatchable to be preserved", () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: { provider: "anthropic", model: "claude-opus-4-7" },
            profiles: {
              placeholder: { label: "Placeholder" },
            },
            profileOrder: ["placeholder"],
            activeProfile: "placeholder",
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.placeholder).toBeUndefined();
    expect(raw.llm.profileOrder).not.toContain("placeholder");
    expect(raw.llm.activeProfile).toBe("custom-balanced");
  });

  test("boot removes non-dispatchable profile references", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          placeholder: { label: "Placeholder" },
          pinned: {
            provider: "anthropic",
            model: "claude-opus-4-7",
          },
          blend: {
            mix: [
              { profile: "placeholder", weight: 1 },
              { profile: "pinned", weight: 1 },
            ],
          },
        },
        profileOrder: ["placeholder", "blend", "pinned"],
        activeProfile: "blend",
        advisorProfile: "placeholder",
        callSites: {
          commitMessage: {
            profile: "placeholder",
            maxTokens: 256,
          },
        },
      },
    });

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.placeholder).toBeUndefined();
    expect(raw.llm.profiles.blend).toBeUndefined();
    expect(raw.llm.profiles.pinned.provider).toBe("anthropic");
    expect(raw.llm.profileOrder).not.toContain("placeholder");
    expect(raw.llm.profileOrder).not.toContain("blend");
    expect(raw.llm.activeProfile).toBe("balanced");
    expect(raw.llm.advisorProfile).toBe("quality-optimized");
    expect(raw.llm.callSites.commitMessage.profile).toBeUndefined();
    expect(raw.llm.callSites.commitMessage.maxTokens).toBe(256);
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

  test("off-platform hatch with openai seeds user profiles and thin managed stubs", () => {
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

    // The managed defaults exist only as thin disabled stubs on a BYOK hatch.
    expect(raw.llm.profiles.balanced).toEqual(managedStub("Balanced"));
    expect(raw.llm.profiles["quality-optimized"]).toEqual(
      managedStub("Quality"),
    );
    expect(raw.llm.profiles["cost-optimized"]).toEqual(managedStub("Speed"));

    // Default content resolves from the code catalog via the effective view.
    // Balanced serves GLM 5.2 on Fireworks.
    const effective = getEffectiveProfiles(raw.llm.profiles);
    expect(effective.balanced?.provider).toBe("fireworks");
    expect(effective.balanced?.provider_connection).toBe("vellum");
    expect(effective.balanced?.model).toBe("accounts/fireworks/models/glm-5p2");
    expect(effective.balanced?.effort).toBe("high");
    expect(effective.balanced?.source).toBe("managed");
    // Quality serves Anthropic Fable, the most capable managed profile.
    expect(effective["quality-optimized"]?.provider).toBe("anthropic");
    expect(effective["quality-optimized"]?.model).toBe("claude-fable-5");
    // Speed is served by DeepSeek V4 Flash on Fireworks.
    expect(effective["cost-optimized"]?.provider).toBe("fireworks");
    expect(effective["cost-optimized"]?.model).toBe(
      "accounts/fireworks/models/deepseek-v4-flash",
    );
  });

  test("off-platform boot leaves an existing managed entry byte-identical", () => {
    // A drifted legacy full-body entry left by a previous release stays
    // exactly as written — boots never rewrite managed entries. Content is
    // served from the code catalog at resolution time instead.
    const drifted = {
      source: "managed",
      provider: "anthropic",
      model: "old-model-from-previous-release",
      provider_connection: "anthropic-managed",
    };
    writeConfig({
      llm: {
        profiles: { balanced: drifted },
        activeProfile: "balanced",
      },
    });

    // Non-hatch boot (no overlay).
    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toEqual(drifted);
    expect(raw.llm.activeProfile).toBe("balanced");
    // Resolution ignores the drifted body: a managed-source entry contributes
    // only label/status/topP, everything else comes from the catalog.
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.model).toBe("accounts/fireworks/models/glm-5p2");
    expect(effectiveBalanced?.provider_connection).toBe("vellum");
  });

  test("boot leaves a source-less legacy canonical profile as a user-owned shadow", () => {
    // Migration 052 seeded canonical profiles without a `source`. A
    // source-less entry on a default name is user-owned: boots leave it
    // byte-identical (never reclaimed or tagged managed), and it shadows the
    // code catalog in the effective view.
    const legacy = {
      provider: "fireworks",
      model: "accounts/fireworks/models/glm-5p2",
      provider_connection: "fireworks-managed",
    };
    writeConfig({
      llm: {
        profiles: { "quality-optimized": legacy },
      },
    });

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles["quality-optimized"]).toEqual(legacy);
    // The shadow wins over the catalog body (which serves claude-fable-5).
    const effectiveQuality = getEffectiveProfile(
      raw.llm.profiles,
      "quality-optimized",
    );
    expect(effectiveQuality?.model).toBe("accounts/fireworks/models/glm-5p2");
    expect(effectiveQuality?.provider_connection).toBe("fireworks-managed");
    expect(effectiveQuality?.source).toBeUndefined();
  });

  test("defaults the advisor profile to the managed Quality profile", () => {
    writeConfig({ llm: { default: { provider: "anthropic" } } });

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    // The strongest active managed default via the effective view. No
    // workspace entry backs it — the content is code-owned.
    expect(raw.llm.advisorProfile).toBe("quality-optimized");
    expect(raw.llm.profiles["quality-optimized"]).toBeUndefined();
    const effectiveQuality = getEffectiveProfile(
      raw.llm.profiles,
      "quality-optimized",
    );
    expect(effectiveQuality?.source).toBe("managed");
    expect(effectiveQuality?.model).toBe("claude-fable-5");
  });

  test("platform boot leaves a drifted managed entry byte-identical; resolution serves catalog content", () => {
    // Headline behavior: default profile content is code-owned, so model/config
    // updates ship in a release without any workspace rewrite. Boots never
    // touch managed entries; the effective view serves the catalog body and
    // overlays only label/status/topP from the workspace entry.
    process.env.IS_PLATFORM = "true";

    const drifted = {
      source: "managed",
      provider: "anthropic",
      model: "old-model-from-previous-release",
      maxTokens: 1,
      provider_connection: "anthropic-managed",
    };
    writeConfig({
      llm: {
        profiles: { balanced: drifted },
        activeProfile: "balanced",
      },
    });

    // Non-hatch boot (no overlay).
    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toEqual(drifted);
    expect(raw.llm.activeProfile).toBe("balanced");
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.model).toBe("accounts/fireworks/models/glm-5p2");
    expect(effectiveBalanced?.maxTokens).toBe(32000);
    expect(effectiveBalanced?.provider_connection).toBe("vellum");
    // The catalog body carries no topP and the entry has none, so the
    // effective profile has no topP override.
    expect("topP" in (effectiveBalanced ?? {})).toBe(false);
  });

  test("platform boot preserves user-edited label and status on a managed stub", () => {
    // The workspace-owned fields a user may set on a managed profile — label
    // and status — live on the stub, which boots never touch. The effective
    // view overlays them onto the code-owned body.
    process.env.IS_PLATFORM = "true";

    const edited = {
      source: "managed",
      label: "My Default",
      status: "disabled",
    };
    writeConfig({
      llm: {
        profiles: { balanced: edited },
        activeProfile: "balanced",
      },
    });

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toEqual(edited);
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    // Content is served from the catalog...
    expect(effectiveBalanced?.model).toBe("accounts/fireworks/models/glm-5p2");
    // ...with the user's label and status overlaid.
    expect(effectiveBalanced?.label).toBe("My Default");
    expect(effectiveBalanced?.status).toBe("disabled");
  });

  test("off-platform boot preserves a user-edited label on a managed stub (Codex P1 on PR #30362)", () => {
    // Simulate a user who renamed the managed "balanced" profile via
    // PUT /v1/config/llm/profiles/balanced { label: "My Default" }.
    const stub = { source: "managed", label: "My Default" };
    writeConfig({
      llm: {
        profiles: { balanced: stub },
        activeProfile: "balanced",
      },
    });

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    // The stub is untouched, and the user's label rides on top of the
    // catalog body in the effective view.
    expect(raw.llm.profiles.balanced).toEqual(stub);
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.label).toBe("My Default");
    expect(effectiveBalanced?.model).toBe("accounts/fireworks/models/glm-5p2");
  });

  test("off-platform boot preserves user-toggled status on a managed stub", () => {
    // Simulate a user who disabled the managed "balanced" profile via
    // PUT /v1/config/llm/profiles/balanced { status: "disabled" }.
    const stub = { source: "managed", status: "disabled" };
    writeConfig({
      llm: {
        profiles: { balanced: stub },
        activeProfile: "balanced",
      },
    });

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toEqual(stub);
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.status).toBe("disabled");
    // Content still comes from the catalog — only label/status/topP are
    // workspace-owned.
    expect(effectiveBalanced?.model).toBe("accounts/fireworks/models/glm-5p2");
  });

  test("boot preserves a user-edited topP override on a managed stub", () => {
    // Simulate a user who overrode topP on the managed "balanced" profile via
    // PUT /v1/config/llm/profiles/balanced { topP: 0.5 }. The override lives
    // on the stub, survives boots untouched, and overlays the catalog body
    // (which carries no topP of its own).
    const stub = { source: "managed", topP: 0.5 };
    writeConfig({
      llm: {
        profiles: { balanced: stub },
        activeProfile: "balanced",
      },
    });

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toEqual(stub);
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.topP).toBe(0.5);
    // Content still comes from the catalog — topP is workspace-owned, the
    // rest is code-owned.
    expect(effectiveBalanced?.model).toBe("accounts/fireworks/models/glm-5p2");
  });

  test("effective balanced profile carries no topP override by default", () => {
    // Boots write no managed entry, and the catalog body (matching the
    // quality profile) carries no topP — so the effective balanced profile
    // has none either.
    writeConfig({ llm: {} });

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toBeUndefined();
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect("topP" in (effectiveBalanced ?? {})).toBe(false);
  });

  test("off-platform reseed preserves an explicit null label (user cleared it)", () => {
    // Setting label to null is the "clear" intent — must survive too,
    // otherwise the next boot would re-stamp the template's default
    // label and ignore the user's clear action.
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

  test("non-hatch off-platform boot writes no managed entries; defaults resolve bare-labeled from the catalog", () => {
    // First boot of a config with no prior profiles and no hatch overlay:
    // nothing is materialized for the default names. The " (Managed)" label
    // suffix exists only on the thin stubs written at BYOK hatch time; a
    // plain boot serves the bare catalog labels through the effective view.
    writeConfig({});

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toBeUndefined();
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.label).toBe("Balanced");
    expect(effectiveBalanced?.model).toBe("accounts/fireworks/models/glm-5p2");
    // Status is unset — the default resolves active.
    expect("status" in (effectiveBalanced ?? {})).toBe(false);
  });

  test("platform overlay fragment stays on disk verbatim; resolution serves catalog content with the overlay label", () => {
    // The overlay's `balanced` fragment lands verbatim on disk and stays
    // there across boots — boots never rewrite managed entries. Resolution,
    // however, always serves default profile CONTENT from the code catalog:
    // a managed-source workspace entry contributes only label/status/topP,
    // so the overlay's provider/model never reach the resolver. Only its
    // `label` shows through the effective view.
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

    // Hatch boot: overlay fragment is preserved verbatim on disk
    // (preserveProfileNames).
    expect(config.llm.activeProfile).toBe("balanced");
    expect(config.llm.profiles.balanced).toEqual({
      source: "managed",
      provider: "openai",
      model: "gpt-5.4",
      label: "Platform Balanced",
    });
    // Resolution serves default-profile CONTENT from the code catalog: the
    // overlay's provider/model never reach the resolver — even on the
    // overlay boot. The overlay-set label is what shows through the
    // effective view.
    expect(mainAgentConfig.provider).toBe("fireworks");
    expect(mainAgentConfig.model).toBe("accounts/fireworks/models/glm-5p2");

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.profiles.balanced).toEqual({
      source: "managed",
      provider: "openai",
      model: "gpt-5.4",
      label: "Platform Balanced",
    });
    expect(raw.llm.profiles.balanced.maxTokens).toBeUndefined();
    expect(raw.llm.profiles.balanced.thinking).toBeUndefined();

    // Next boot, no overlay: the entry stays byte-identical on disk, and
    // resolution keeps serving the fireworks-managed catalog body with the
    // overlay's label on top.
    mergeDefaultConfigAndSeedInferenceProfiles();

    const afterRestart = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(afterRestart.llm.activeProfile).toBe("balanced");
    expect(afterRestart.llm.profiles.balanced).toEqual({
      source: "managed",
      provider: "openai",
      model: "gpt-5.4",
      label: "Platform Balanced",
    });
    const effectiveBalanced = getEffectiveProfile(
      afterRestart.llm.profiles,
      "balanced",
    );
    expect(effectiveBalanced?.provider).toBe("fireworks");
    expect(effectiveBalanced?.provider_connection).toBe("vellum");
    expect(effectiveBalanced?.model).toBe("accounts/fireworks/models/glm-5p2");
    expect(effectiveBalanced?.maxTokens).toBe(32000);
    expect(effectiveBalanced?.thinking).toEqual({
      enabled: true,
      streamThinking: true,
    });
    expect(effectiveBalanced?.label).toBe("Platform Balanced");
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
    // Off-platform hatch: user profiles are active; the managed defaults get
    // only thin disabled stubs.
    expect(raw.llm.activeProfile).toBe("custom-balanced");
    expect(raw.llm.profiles["custom-balanced"].provider).toBe("anthropic");
    expect(raw.llm.profiles.balanced).toEqual(managedStub("Balanced"));
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.model).toBe("accounts/fireworks/models/glm-5p2");
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
// Tests: BYOK-mode seed behavior (issues #2/#3/#4 of the May 12 provider UX
// queue). Off-platform managed defaults share base labels with the personal
// "custom-*" profiles (Balanced / Quality / Speed), so the thin stubs written
// at BYOK hatch time carry a " (Managed)" label suffix and status "disabled"
// — a fresh BYOK user has no platform auth, so managed defaults must not
// surface as enabled in the picker on day one. Boots never touch managed
// entries, so post-hatch user toggles persist — the "never auto-disable BYOK
// connections" rule applies to RESTART, not to hatch. On platform, no
// managed entries are written at all; defaults resolve from the code catalog.
// ---------------------------------------------------------------------------

describe("seedInferenceProfiles BYOK-mode managed profile labels", () => {
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

  test("off-platform hatch initializes managed profile status to 'disabled'", () => {
    // On a fresh BYOK hatch the user has no platform auth, so managed
    // profiles must not surface as enabled in the picker on day one. We
    // flip the three canonical managed profiles to status="disabled"
    // ONCE at hatch time. (The complementary "user re-enable persists
    // across restarts" guarantee is covered by the test further down.)
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
  });

  test("off-platform BYOK hatch defaults advisor to the personal quality profile", () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({ llm: { default: { provider: "anthropic" } } }, null, 2) +
        "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();
    const config = loadConfig();

    expect(config.llm.activeProfile).toBe("custom-balanced");
    expect(config.llm.advisorProfile).toBe("custom-quality-optimized");
    expect(config.llm.profiles["custom-quality-optimized"]?.provider).toBe(
      "anthropic",
    );
    expect(
      config.llm.profiles["custom-quality-optimized"]?.provider_connection,
    ).toBe("anthropic-personal");
  });

  test("off-platform boot repairs a disabled managed advisor to a personal profile when no active managed replacement exists", () => {
    writeConfig({
      llm: {
        advisorProfile: "frontier",
        profiles: {
          frontier: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-opus-4-8",
            status: "disabled",
          },
          balanced: {
            source: "managed",
            provider: "together",
            provider_connection: "together-managed",
            model: "open-model",
            status: "disabled",
          },
          "quality-optimized": {
            source: "managed",
            provider: "fireworks",
            provider_connection: "fireworks-managed",
            model: "accounts/fireworks/models/glm-5p2",
            status: "disabled",
          },
          "cost-optimized": {
            source: "managed",
            provider: "fireworks",
            provider_connection: "fireworks-managed",
            model: "accounts/fireworks/models/deepseek-v4-flash",
            status: "disabled",
          },
          "custom-quality-optimized": {
            source: "user",
            provider: "anthropic",
            provider_connection: "anthropic-personal",
            model: "claude-opus-4-8",
            label: "Quality",
          },
        },
      },
    });

    mergeDefaultConfigAndSeedInferenceProfiles();
    const config = loadConfig();

    expect(config.llm.advisorProfile).toBe("custom-quality-optimized");
  });

  test("platform boot repairs a disabled managed advisor to an active managed profile", () => {
    process.env.IS_PLATFORM = "true";
    writeConfig({
      llm: {
        advisorProfile: "frontier",
        profiles: {
          frontier: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-opus-4-8",
            status: "disabled",
          },
          "custom-quality-optimized": {
            source: "user",
            provider: "anthropic",
            provider_connection: "anthropic-personal",
            model: "claude-opus-4-8",
            label: "Quality",
          },
        },
      },
    });

    mergeDefaultConfigAndSeedInferenceProfiles();
    const config = loadConfig();

    expect(config.llm.advisorProfile).toBe("quality-optimized");
  });

  test("off-platform boot clears a disabled managed advisor when no active replacement exists", () => {
    writeConfig({
      llm: {
        advisorProfile: "frontier",
        profiles: {
          frontier: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-opus-4-8",
            status: "disabled",
          },
          balanced: {
            source: "managed",
            provider: "together",
            provider_connection: "together-managed",
            model: "open-model",
            status: "disabled",
          },
          "quality-optimized": {
            source: "managed",
            provider: "fireworks",
            provider_connection: "fireworks-managed",
            model: "accounts/fireworks/models/glm-5p2",
            status: "disabled",
          },
          "cost-optimized": {
            source: "managed",
            provider: "fireworks",
            provider_connection: "fireworks-managed",
            model: "accounts/fireworks/models/deepseek-v4-flash",
            status: "disabled",
          },
        },
      },
    });

    mergeDefaultConfigAndSeedInferenceProfiles();
    const config = loadConfig();

    expect(config.llm.advisorProfile).toBeUndefined();
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
    // The hatch overlay selected a managed profile (all managed profiles
    // share the single `vellum` connection), so no disabled stubs are
    // written: the defaults stay absent from llm.profiles and resolve active
    // from the code catalog. The default advisor falls to the strongest
    // active managed profile, `quality-optimized`.
    expect(raw.llm.advisorProfile).toBe("quality-optimized");
    expect(raw.llm.profiles.balanced).toBeUndefined();
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.provider_connection).toBe("vellum");
    expect("status" in (effectiveBalanced ?? {})).toBe(false);
  });

  test("off-platform managed-inference hatch respects explicit non-managed active connection", () => {
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

    expect(raw.llm.activeProfile).toBe("balanced");
    expect(raw.llm.profiles.balanced.provider_connection).toBe(
      "anthropic-personal",
    );
    // Connections exist (status is no longer a connection-level concept).
    expect(getConnection(db, "anthropic-managed")).not.toBeNull();
    expect(getConnection(db, "openai-managed")).not.toBeNull();
    expect(getConnection(db, "gemini-managed")).not.toBeNull();
  });

  test("non-hatch off-platform boot writes no managed entries and never auto-disables the defaults", () => {
    // Existing installs that upgrade to a version where the workspace
    // carries no entries for the default names get nothing materialized on
    // a normal boot — and therefore nothing auto-disabled. The disabled
    // stubs are written only at BYOK hatch time; without an overlay there
    // is no hatch signal, and the defaults resolve active from the code
    // catalog. This is the "we never want to auto-disable BYOK connections
    // on restart" guarantee.
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        // Note: no `profiles` key — the default names stay absent from the
        // workspace after the boot.
      },
    });

    // No overlay → not a hatch.
    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toBeUndefined();
    expect(raw.llm.profiles["quality-optimized"]).toBeUndefined();
    expect(raw.llm.profiles["cost-optimized"]).toBeUndefined();
    const effective = getEffectiveProfiles(raw.llm.profiles);
    expect("status" in (effective.balanced ?? {})).toBe(false);
    expect("status" in (effective["quality-optimized"] ?? {})).toBe(false);
    expect("status" in (effective["cost-optimized"] ?? {})).toBe(false);
  });

  test("on-platform hatch writes no managed stubs; catalog labels stay bare", () => {
    process.env.IS_PLATFORM = "true";

    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({ llm: { default: { provider: "anthropic" } } }, null, 2) +
        "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    // Platform hatches materialize nothing, and the catalog labels carry no
    // "(Managed)" suffix — the personal profiles don't exist here so there's
    // nothing to disambiguate from.
    expect(raw.llm.profiles).toEqual({});
    const effective = getEffectiveProfiles(raw.llm.profiles);
    expect(effective.balanced?.label).toBe("Balanced");
    expect(effective["quality-optimized"]?.label).toBe("Quality");
    expect(effective["cost-optimized"]?.label).toBe("Speed");
  });

  test("boot leaves legacy bare labels on managed entries untouched", () => {
    // Existing off-platform install has bare labels (`label: "Balanced"`)
    // on its managed entries. Boots never rewrite managed entries — there
    // is no label-suffix upgrade pass — so the entries stay byte-identical
    // and the bare labels flow through the effective view.
    const legacyProfiles = {
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
    };
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: legacyProfiles,
        activeProfile: "balanced",
      },
    });

    // No overlay → not a hatch.
    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles).toEqual(legacyProfiles);
    const effective = getEffectiveProfiles(raw.llm.profiles);
    expect(effective.balanced?.label).toBe("Balanced");
    expect(effective["quality-optimized"]?.label).toBe("Quality");
    expect(effective["cost-optimized"]?.label).toBe("Speed");
  });

  test("boot preserves user-customized labels and explicit null on off-platform", () => {
    // A user-set string that differs from the bare default survives, as
    // does an explicit null (user cleared the label) — boots never touch
    // managed entries, whatever label state they carry.
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
          // Already-suffixed labels are also preserved (idempotency).
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

  test("platform boot leaves a bare label on a managed entry untouched", () => {
    // An on-platform install with a bare "Balanced" label keeps it — boots
    // never rewrite managed entries, and no suffix exists on platform.
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

// ---------------------------------------------------------------------------
// Tests: OS Beta flag-gated managed profile. The template is defined but
// intentionally NOT part of MANAGED_PROFILE_TEMPLATES, so seedInferenceProfiles
// must never create it. The flag-gated reconcile creates or removes it based on
// the `os-beta` feature flag.
// ---------------------------------------------------------------------------

describe("OS Beta managed profile template", () => {
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

  test("seedInferenceProfiles does not create an os-beta profile", () => {
    writeConfig({ llm: { default: { provider: "anthropic" } } });

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles["os-beta"]).toBeUndefined();
    expect((raw.llm.profileOrder as string[]).includes("os-beta")).toBe(false);
  });

  test("MANAGED_PROFILE_NAMES contains os-beta", () => {
    expect(MANAGED_PROFILE_NAMES.has("os-beta")).toBe(true);
  });

  test("materializeProfile resolves OS Beta to the Balanced model with low effort", () => {
    const entry = materializeProfile(
      OS_BETA_PROFILE_TEMPLATE,
      "together",
      "vellum",
    );

    expect(entry.model).toBe("MiniMaxAI/MiniMax-M3");
    expect(entry.provider_connection).toBe("vellum");
    expect(entry.provider).toBe("together");
    expect(entry.label).toBe("OS Beta");
    expect(entry.source).toBe("managed");
    expect(entry.maxTokens).toBe(32000);
    expect(entry.effort).toBe("low");
    expect(entry.thinking?.enabled).toBe(true);
    expect(entry.topP).toBe(0.95);
  });
});

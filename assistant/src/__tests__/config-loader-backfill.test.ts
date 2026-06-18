import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

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

// ---------------------------------------------------------------------------
// Managed-profile fetch seam. The seeder fetches managed profiles from the
// platform; mock it so tests control the discriminated result. The default is
// "no-connection" (the common test environment), and individual tests override
// `managedFetchResult` before invoking the seeder.
// ---------------------------------------------------------------------------

type PlatformManagedProfile = {
  key: string;
  intent: string;
  provider: string;
  connection_name: string;
  source: string;
  label: string;
  description: string;
  max_tokens: number;
  effort: string;
  thinking: { enabled: boolean; stream_thinking: boolean };
  context_window: { max_input_tokens: number };
};

type FetchManagedProfilesResult =
  | { status: "no-connection" }
  | { status: "ok"; profiles: PlatformManagedProfile[] }
  | { status: "error" };

let managedFetchResult: FetchManagedProfilesResult = {
  status: "no-connection",
};

function managedProfileFixture(
  key: string,
  overrides: Partial<PlatformManagedProfile> = {},
): PlatformManagedProfile {
  const base: Record<string, PlatformManagedProfile> = {
    balanced: {
      key: "balanced",
      intent: "balanced",
      provider: "anthropic",
      connection_name: "anthropic-managed",
      source: "managed",
      label: "Balanced",
      description: "Good balance of quality, cost, and speed",
      max_tokens: 16000,
      effort: "high",
      thinking: { enabled: true, stream_thinking: true },
      context_window: { max_input_tokens: 200000 },
    },
    "quality-optimized": {
      key: "quality-optimized",
      intent: "quality-optimized",
      provider: "anthropic",
      connection_name: "anthropic-managed",
      source: "managed",
      label: "Quality",
      description: "Best results with the most capable model",
      max_tokens: 32000,
      effort: "high",
      thinking: { enabled: true, stream_thinking: true },
      context_window: { max_input_tokens: 200000 },
    },
    "cost-optimized": {
      key: "cost-optimized",
      intent: "latency-optimized",
      provider: "anthropic",
      connection_name: "anthropic-managed",
      source: "managed",
      label: "Speed",
      description: "Fastest responses at lower cost",
      max_tokens: 8192,
      effort: "low",
      thinking: { enabled: false, stream_thinking: false },
      context_window: { max_input_tokens: 200000 },
    },
    "balanced-economy": {
      key: "balanced-economy",
      intent: "balanced",
      provider: "fireworks",
      connection_name: "fireworks-managed",
      source: "managed",
      label: "Balanced Economy",
      description: "Strong open model (MiniMax M3) at a lower price point",
      max_tokens: 32000,
      effort: "high",
      thinking: { enabled: true, stream_thinking: true },
      context_window: { max_input_tokens: 200000 },
    },
  };
  return { ...base[key], ...overrides };
}

function allManagedProfileFixtures(): PlatformManagedProfile[] {
  return [
    "balanced",
    "quality-optimized",
    "cost-optimized",
    "balanced-economy",
  ].map((k) => managedProfileFixture(k));
}

mock.module("../platform/managed-profiles.js", () => ({
  fetchManagedProfiles: async () => managedFetchResult,
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
import { LLMSchema } from "../config/schemas/llm.js";
import { seedInferenceProfiles } from "../config/seed-inference-profiles.js";
import type { DrizzleDb } from "../memory/db-connection.js";
import { getConfigQuarantineNoticePath } from "../util/platform.js";
import { setStorePathForTesting } from "./encrypted-store-test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n");
}

async function mergeDefaultConfigAndSeedInferenceProfiles(
  db?: DrizzleDb,
): Promise<void> {
  const defaultConfigMerge = mergeDefaultWorkspaceConfig();
  await seedInferenceProfiles({
    preserveProfileNames: defaultConfigMerge.providedLlmProfileNames,
    preserveActiveProfile: defaultConfigMerge.providedLlmActiveProfile,
    isHatch: defaultConfigMerge.hadOverlay,
    db,
  });
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
    managedFetchResult = { status: "no-connection" };
    invalidateConfigCache();
  });

  afterEach(() => {
    setStorePathForTesting(null);
    delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
    delete process.env.IS_PLATFORM;
    managedFetchResult = { status: "no-connection" };
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

  test("off-platform hatch seeds both managed and user anthropic profiles", async () => {
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
    managedFetchResult = {
      status: "ok",
      profiles: allManagedProfileFixtures(),
    };

    await mergeDefaultConfigAndSeedInferenceProfiles();
    const config = loadConfig();

    expect(config.llm.default.provider).toBe("anthropic");
    expect(config.llm.default.model).toBe("claude-opus-4-7");
    // Off-platform: user profiles are active, backed by the user's API key.
    expect(config.llm.activeProfile).toBe("custom-balanced");
    expect(config.llm.profiles["custom-balanced"]?.provider).toBe("anthropic");
    expect(config.llm.profiles["custom-balanced"]?.provider_connection).toBe(
      "anthropic-personal",
    );
    // Managed profiles come from the platform fetch; model is resolved from intent.
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
    expect(raw.llm.profiles.balanced.model).toBe("claude-sonnet-4-6");
  });

  test("on-platform hatch seeds only managed profiles", async () => {
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
    managedFetchResult = {
      status: "ok",
      profiles: allManagedProfileFixtures(),
    };

    await mergeDefaultConfigAndSeedInferenceProfiles();
    const config = loadConfig();

    expect(config.llm.activeProfile).toBe("balanced");
    expect(config.llm.profiles.balanced?.model).toBe("claude-sonnet-4-6");
    expect(config.llm.profiles.balanced?.provider_connection).toBe(
      "anthropic-managed",
    );
    // No user profiles created on platform.
    expect(config.llm.profiles["custom-balanced"]).toBeUndefined();
  });

  test("re-hatch from openai to anthropic creates user anthropic profiles off-platform", async () => {
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
    managedFetchResult = {
      status: "ok",
      profiles: allManagedProfileFixtures(),
    };

    await mergeDefaultConfigAndSeedInferenceProfiles();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    // Off-platform re-hatch: user profiles are overwritten for the new
    // provider and custom-balanced becomes active.
    expect(raw.llm.activeProfile).toBe("custom-balanced");
    expect(raw.llm.profiles["custom-balanced"].provider).toBe("anthropic");
    expect(raw.llm.profiles["custom-balanced"].provider_connection).toBe(
      "anthropic-personal",
    );
    // Managed balanced profile is seeded for anthropic-managed.
    expect(raw.llm.profiles.balanced.provider).toBe("anthropic");
    expect(raw.llm.profiles.balanced.provider_connection).toBe(
      "anthropic-managed",
    );
  });

  test("on-platform re-hatch resets active profile to balanced", async () => {
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
    managedFetchResult = {
      status: "ok",
      profiles: allManagedProfileFixtures(),
    };

    await mergeDefaultConfigAndSeedInferenceProfiles();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    // On-platform: no user profiles created, active resets to managed balanced.
    expect(raw.llm.activeProfile).toBe("balanced");
    expect(raw.llm.profiles.balanced.provider).toBe("anthropic");
    expect(raw.llm.profiles.balanced.provider_connection).toBe(
      "anthropic-managed",
    );
    // The old custom-balanced is preserved on disk but no longer active.
    expect(raw.llm.profiles["custom-balanced"].provider).toBe("openai");
  });

  test("preserves user-supplied non-catalog model on every restart (ollama custom model)", async () => {
    // Models the ollama case: catalog lists only `llama3.2` but the user has
    // pulled `codellama`. The seeder must NOT silently overwrite their pick.
    writeConfig({
      llm: { default: { provider: "ollama", model: "codellama" } },
    });

    await mergeDefaultConfigAndSeedInferenceProfiles();
    let raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.default.model).toBe("codellama");

    // Re-run to confirm idempotency — the user's model survives every restart.
    await mergeDefaultConfigAndSeedInferenceProfiles();
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.default.model).toBe("codellama");
  });

  test("off-platform hatch with openai seeds user profiles and managed anthropic profiles", async () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({ llm: { default: { provider: "openai" } } }, null, 2) +
        "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;
    managedFetchResult = {
      status: "ok",
      profiles: allManagedProfileFixtures(),
    };

    await mergeDefaultConfigAndSeedInferenceProfiles();
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

    // Managed profiles are also seeded (balanced uses Anthropic).
    expect(raw.llm.profiles.balanced.provider).toBe("anthropic");
    expect(raw.llm.profiles.balanced.provider_connection).toBe(
      "anthropic-managed",
    );
    expect(raw.llm.profiles.balanced.source).toBe("managed");
    expect(raw.llm.profiles["quality-optimized"].provider).toBe("anthropic");
    expect(raw.llm.profiles["cost-optimized"].provider).toBe("anthropic");
  });

  test("connected: managed profiles are seeded from the platform fetch", async () => {
    // Simulate a previous boot that left a stale managed profile on disk.
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

    managedFetchResult = {
      status: "ok",
      profiles: allManagedProfileFixtures(),
    };

    await mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    // All four platform profiles are seeded with the model resolved from intent.
    expect(raw.llm.profiles.balanced.model).toBe("claude-sonnet-4-6");
    expect(raw.llm.profiles.balanced.provider).toBe("anthropic");
    expect(raw.llm.profiles.balanced.provider_connection).toBe(
      "anthropic-managed",
    );
    expect(raw.llm.profiles.balanced.source).toBe("managed");
    expect(raw.llm.profiles.balanced.maxTokens).toBe(16000);
    expect(raw.llm.profiles.balanced.effort).toBe("high");
    expect(raw.llm.profiles.balanced.thinking).toEqual({
      enabled: true,
      streamThinking: true,
    });
    expect(raw.llm.profiles.balanced.contextWindow).toEqual({
      maxInputTokens: 200000,
    });
    // Labels are taken verbatim — no "(Managed)" suffix.
    expect(raw.llm.profiles.balanced.label).toBe("Balanced");
    expect(raw.llm.profiles["quality-optimized"].label).toBe("Quality");
    expect(raw.llm.profiles["cost-optimized"].model).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(raw.llm.profiles["balanced-economy"].provider).toBe("fireworks");
    expect(raw.llm.profiles["balanced-economy"].provider_connection).toBe(
      "fireworks-managed",
    );

    // All four appear in profileOrder in canonical order, after "auto".
    expect(raw.llm.profileOrder).toEqual([
      "auto",
      "balanced",
      "quality-optimized",
      "cost-optimized",
      "balanced-economy",
    ]);
    expect(raw.llm.activeProfile).toBe("balanced");
  });

  test("connected: user-edited label and status survive a reseed", async () => {
    // The only two fields a user may override on a managed profile — label and
    // status — survive the platform reconcile. An explicit null label (user
    // cleared it) survives too.
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            model: "old-model-from-previous-release",
            provider_connection: "anthropic-managed",
            label: "My Default",
            status: "disabled",
          },
          "quality-optimized": {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            label: null,
          },
        },
        activeProfile: "balanced",
      },
    });

    managedFetchResult = {
      status: "ok",
      profiles: allManagedProfileFixtures(),
    };

    await mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    // Content refreshes from the platform...
    expect(raw.llm.profiles.balanced.model).toBe("claude-sonnet-4-6");
    // ...but the user's label and status overrides are preserved.
    expect(raw.llm.profiles.balanced.label).toBe("My Default");
    expect(raw.llm.profiles.balanced.status).toBe("disabled");
    // Explicit null label survives too.
    expect(raw.llm.profiles["quality-optimized"].label).toBeNull();
  });

  test("connected: platform dropping a profile prunes it from profiles and profileOrder", async () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-sonnet-4-6",
          },
          "balanced-economy": {
            source: "managed",
            provider: "fireworks",
            provider_connection: "fireworks-managed",
            model: "accounts/fireworks/models/minimax-m3",
          },
        },
        profileOrder: ["auto", "balanced", "balanced-economy"],
        activeProfile: "balanced",
      },
    });

    // Platform now returns only three keys — balanced-economy is dropped.
    managedFetchResult = {
      status: "ok",
      profiles: [
        managedProfileFixture("balanced"),
        managedProfileFixture("quality-optimized"),
        managedProfileFixture("cost-optimized"),
      ],
    };

    await mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles["balanced-economy"]).toBeUndefined();
    expect(raw.llm.profileOrder).not.toContain("balanced-economy");
    expect(raw.llm.profiles.balanced).toBeDefined();
    expect(raw.llm.profiles["quality-optimized"]).toBeDefined();
    expect(raw.llm.profiles["cost-optimized"]).toBeDefined();
  });

  test("connected: platform profile with an unrecognized key is ignored", async () => {
    // A future profile key the running code doesn't yet recognize must not be
    // half-seeded (written to `profiles` but never ordered, pruned, or
    // write-protected). It is skipped entirely until the key is added to
    // MANAGED_PROFILE_KEYS; the recognized keys seed normally.
    managedFetchResult = {
      status: "ok",
      profiles: [
        managedProfileFixture("balanced"),
        managedProfileFixture("quality-optimized"),
        managedProfileFixture("cost-optimized"),
        managedProfileFixture("balanced-economy"),
        managedProfileFixture("balanced", { key: "economy-quality" }),
      ],
    };

    await mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    // Unrecognized key is neither seeded nor ordered.
    expect(raw.llm.profiles["economy-quality"]).toBeUndefined();
    expect(raw.llm.profileOrder).not.toContain("economy-quality");
    // Recognized keys seed normally.
    expect(raw.llm.profiles.balanced).toBeDefined();
    expect(raw.llm.profiles["quality-optimized"]).toBeDefined();
    expect(raw.llm.profiles["cost-optimized"]).toBeDefined();
    expect(raw.llm.profiles["balanced-economy"]).toBeDefined();
    expect(raw.llm.profileOrder).toEqual([
      "auto",
      "balanced",
      "quality-optimized",
      "cost-optimized",
      "balanced-economy",
    ]);
  });

  test("no connection: all managed profiles are pruned; auto and custom-* survive", async () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({ llm: { default: { provider: "anthropic" } } }, null, 2) +
        "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;
    managedFetchResult = { status: "no-connection" };

    await mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    for (const key of [
      "balanced",
      "quality-optimized",
      "cost-optimized",
      "balanced-economy",
    ]) {
      expect(raw.llm.profiles[key]).toBeUndefined();
      expect(raw.llm.profileOrder).not.toContain(key);
    }
    // Auto is always seeded.
    expect(raw.llm.profiles.auto).toBeDefined();
    expect(raw.llm.profileOrder).toContain("auto");
    // Off-platform hatch still creates the personal custom-* profiles.
    expect(raw.llm.profiles["custom-balanced"].provider).toBe("anthropic");
    // The active profile resolves to one that exists.
    expect(raw.llm.activeProfile).toBe("custom-balanced");
    expect(raw.llm.profiles[raw.llm.activeProfile]).toBeDefined();
  });

  test("no connection: previously-seeded managed profiles are pruned on a normal boot", async () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-sonnet-4-6",
          },
          "cost-optimized": {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-haiku-4-5-20251001",
          },
        },
        profileOrder: ["auto", "balanced", "cost-optimized"],
        activeProfile: "balanced",
      },
    });

    managedFetchResult = { status: "no-connection" };

    await mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toBeUndefined();
    expect(raw.llm.profiles["cost-optimized"]).toBeUndefined();
    expect(raw.llm.profileOrder).toEqual(["auto"]);
    // Active reset to a profile that exists (auto, as nothing else is seeded).
    expect(raw.llm.profiles[raw.llm.activeProfile]).toBeDefined();
  });

  test("fetch error: existing managed profiles on disk are left untouched", async () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "old-model-from-previous-release",
            label: "On-Disk Label",
            maxTokens: 12345,
          },
        },
        profileOrder: ["auto", "balanced"],
        activeProfile: "balanced",
      },
    });

    managedFetchResult = { status: "error" };

    await mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    // Not overwritten, not pruned — left exactly as-is.
    expect(raw.llm.profiles.balanced.model).toBe(
      "old-model-from-previous-release",
    );
    expect(raw.llm.profiles.balanced.label).toBe("On-Disk Label");
    expect(raw.llm.profiles.balanced.maxTokens).toBe(12345);
    expect(raw.llm.profileOrder).toContain("balanced");
    expect(raw.llm.activeProfile).toBe("balanced");
  });

  test("active-profile reset: pruned active profile falls back to an existing one", async () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-sonnet-4-6",
          },
        },
        profileOrder: ["auto", "balanced"],
        activeProfile: "balanced",
      },
    });

    // No connection prunes balanced — the active profile no longer exists.
    managedFetchResult = { status: "no-connection" };

    await mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toBeUndefined();
    // activeProfile reset to a profile that exists in profiles.
    expect(raw.llm.profiles[raw.llm.activeProfile]).toBeDefined();
  });

  test("off-platform hatch without a user connection (ollama): active profile resolves to an existing profile after prune", async () => {
    // Ollama hatches are excluded from custom-* user-profile creation, so
    // `userConnectionName` is falsy. With no platform connection all managed
    // profiles — including `balanced` — are pruned, so the hatch default must
    // fall back to a profile that still exists (auto) rather than `balanced`.
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({ llm: { default: { provider: "ollama" } } }, null, 2) +
        "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;
    managedFetchResult = { status: "no-connection" };

    await mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    // No custom-* profiles for ollama, and all managed profiles pruned.
    expect(raw.llm.profiles["custom-balanced"]).toBeUndefined();
    expect(raw.llm.profiles.balanced).toBeUndefined();
    // The hatch active-profile default must point at an existing profile —
    // `balanced` no longer exists, so it resolves to `auto`.
    expect(raw.llm.activeProfile).not.toBe("balanced");
    expect(raw.llm.activeProfile).toBe("auto");
    expect(raw.llm.profiles[raw.llm.activeProfile]).toBeDefined();
  });

  test("no connection: call-site pins to pruned managed profiles are cleared and config stays valid", async () => {
    // An earlier workspace migration may have pinned background call sites at
    // managed profiles. When those profiles are pruned the pins must be
    // scrubbed, or `LLMSchema` rejects the raw config for referencing an
    // undefined profile.
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-sonnet-4-6",
          },
          "cost-optimized": {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-haiku-4-5-20251001",
          },
        },
        profileOrder: ["auto", "balanced", "cost-optimized"],
        activeProfile: "balanced",
        callSites: {
          memoryRouter: { profile: "cost-optimized" },
          subagentSpawn: { profile: "balanced", maxTokens: 8192 },
        },
      },
    });

    managedFetchResult = { status: "no-connection" };

    await mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    // Managed profiles pruned.
    expect(raw.llm.profiles.balanced).toBeUndefined();
    expect(raw.llm.profiles["cost-optimized"]).toBeUndefined();
    // Pruned call-site `profile` pins removed; other overrides survive.
    expect(raw.llm.callSites.memoryRouter.profile).toBeUndefined();
    expect(raw.llm.callSites.subagentSpawn.profile).toBeUndefined();
    expect(raw.llm.callSites.subagentSpawn.maxTokens).toBe(8192);
    // Raw config parses cleanly — no undefined-profile-reference error.
    expect(LLMSchema.safeParse(raw.llm).success).toBe(true);
  });

  test("ok with a dropped managed key: call-site pin to the dropped key is cleared", async () => {
    // The platform fetch returns only a subset of managed keys; the absent key
    // is pruned, and any call-site pin to it must be scrubbed too.
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-sonnet-4-6",
          },
          "cost-optimized": {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-haiku-4-5-20251001",
          },
        },
        profileOrder: ["auto", "balanced", "cost-optimized"],
        activeProfile: "balanced",
        callSites: {
          memoryRouter: { profile: "cost-optimized" },
        },
      },
    });

    // Fetch returns balanced but NOT cost-optimized → cost-optimized is pruned.
    managedFetchResult = {
      status: "ok",
      profiles: [managedProfileFixture("balanced")],
    };

    await mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toBeDefined();
    expect(raw.llm.profiles["cost-optimized"]).toBeUndefined();
    // The pin to the dropped key is cleared.
    expect(raw.llm.callSites.memoryRouter.profile).toBeUndefined();
    // The surviving key keeps any unrelated pins.
    expect(LLMSchema.safeParse(raw.llm).success).toBe(true);
  });

  test("no connection: mix arm referencing a pruned managed profile is removed; mix survives with remaining arms", async () => {
    // A user built a mix while connected, weighting a managed profile
    // (`balanced`) against their own profile. Losing the platform connection
    // prunes `balanced`; the dangling arm must be removed so the mix (which
    // still has two valid arms) keeps parsing under LLMSchema.
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-sonnet-4-6",
          },
          "custom-quality-optimized": {
            source: "user",
            provider: "anthropic",
            provider_connection: "anthropic-personal",
            model: "claude-opus-4-7",
          },
          "custom-cost-optimized": {
            source: "user",
            provider: "anthropic",
            provider_connection: "anthropic-personal",
            model: "claude-haiku-4-5-20251001",
          },
          "my-mix": {
            source: "user",
            mix: [
              { profile: "balanced", weight: 1 },
              { profile: "custom-quality-optimized", weight: 1 },
              { profile: "custom-cost-optimized", weight: 1 },
            ],
          },
        },
        profileOrder: ["auto", "balanced", "my-mix"],
        activeProfile: "my-mix",
      },
    });

    managedFetchResult = { status: "no-connection" };

    await mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    // `balanced` is pruned; the mix loses that arm but keeps its valid ones.
    expect(raw.llm.profiles.balanced).toBeUndefined();
    expect(raw.llm.profiles["my-mix"]).toBeDefined();
    expect(raw.llm.profiles["my-mix"].mix).toEqual([
      { profile: "custom-quality-optimized", weight: 1 },
      { profile: "custom-cost-optimized", weight: 1 },
    ]);
    expect(raw.llm.profileOrder).toContain("my-mix");
    // The post-seed config parses cleanly — no dangling mix-arm reference.
    expect(LLMSchema.safeParse(raw.llm).success).toBe(true);
  });

  test("no connection: mix falling below two arms is deleted and dropped from order/active", async () => {
    // The mix's only other arm is itself a managed profile, so pruning leaves a
    // single valid arm — below `MixSchema.min(2)`. The whole mix is removed and
    // every reference to it (profileOrder, activeProfile) is cleaned up.
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-sonnet-4-6",
          },
          "cost-optimized": {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-haiku-4-5-20251001",
          },
          "custom-quality-optimized": {
            source: "user",
            provider: "anthropic",
            provider_connection: "anthropic-personal",
            model: "claude-opus-4-7",
          },
          "my-mix": {
            source: "user",
            mix: [
              { profile: "balanced", weight: 1 },
              { profile: "cost-optimized", weight: 1 },
            ],
          },
        },
        profileOrder: ["auto", "balanced", "cost-optimized", "my-mix"],
        activeProfile: "my-mix",
        callSites: {
          memoryRouter: { profile: "my-mix" },
        },
      },
    });

    managedFetchResult = { status: "no-connection" };

    await mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    // Both managed arms are pruned, leaving the mix below its two-arm minimum,
    // so the mix profile itself is deleted.
    expect(raw.llm.profiles.balanced).toBeUndefined();
    expect(raw.llm.profiles["cost-optimized"]).toBeUndefined();
    expect(raw.llm.profiles["my-mix"]).toBeUndefined();
    // The deleted mix is dropped from profileOrder and is not the active profile.
    expect(raw.llm.profileOrder).not.toContain("my-mix");
    expect(raw.llm.activeProfile).not.toBe("my-mix");
    expect(raw.llm.profiles[raw.llm.activeProfile]).toBeDefined();
    // The call-site pin to the deleted mix is scrubbed too (mix added to the
    // pruned set before the call-site scrub).
    expect(raw.llm.callSites.memoryRouter.profile).toBeUndefined();
    // The post-seed config parses cleanly.
    expect(LLMSchema.safeParse(raw.llm).success).toBe(true);
  });

  test("ok with a dropped managed key: mix arm to the dropped key is removed and config stays valid", async () => {
    // The platform fetch drops `cost-optimized`; a mix that referenced it must
    // shed that arm. Two other valid arms remain, so the mix survives.
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-sonnet-4-6",
          },
          "cost-optimized": {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-haiku-4-5-20251001",
          },
          "custom-quality-optimized": {
            source: "user",
            provider: "anthropic",
            provider_connection: "anthropic-personal",
            model: "claude-opus-4-7",
          },
          "my-mix": {
            source: "user",
            mix: [
              { profile: "balanced", weight: 2 },
              { profile: "cost-optimized", weight: 1 },
              { profile: "custom-quality-optimized", weight: 1 },
            ],
          },
        },
        profileOrder: ["auto", "balanced", "cost-optimized", "my-mix"],
        activeProfile: "my-mix",
      },
    });

    // Fetch returns balanced but NOT cost-optimized → cost-optimized is pruned.
    managedFetchResult = {
      status: "ok",
      profiles: [managedProfileFixture("balanced")],
    };

    await mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles["cost-optimized"]).toBeUndefined();
    expect(raw.llm.profiles["my-mix"]).toBeDefined();
    expect(raw.llm.profiles["my-mix"].mix).toEqual([
      { profile: "balanced", weight: 2 },
      { profile: "custom-quality-optimized", weight: 1 },
    ]);
    expect(raw.llm.profileOrder).toContain("my-mix");
    expect(LLMSchema.safeParse(raw.llm).success).toBe(true);
  });

  test("connected: platform fetch is authoritative over any overlay fragment for managed keys", async () => {
    // The platform model-profiles endpoint — not the hatch overlay — owns
    // managed profile content. An overlay fragment for a managed key does not
    // win; the fetched content lands instead. Only the user `label`/`status`
    // already on disk are carried across.
    process.env.IS_PLATFORM = "true";

    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: { provider: "openai", model: "gpt-5.4" },
            profiles: {
              balanced: {
                source: "managed",
                provider: "openai",
                model: "gpt-5.4",
                label: "Overlay Balanced",
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
    managedFetchResult = {
      status: "ok",
      profiles: allManagedProfileFixtures(),
    };

    await mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    // Fetched content wins over the overlay fragment...
    expect(raw.llm.profiles.balanced.provider).toBe("anthropic");
    expect(raw.llm.profiles.balanced.model).toBe("claude-sonnet-4-6");
    expect(raw.llm.profiles.balanced.provider_connection).toBe(
      "anthropic-managed",
    );
    // ...but the overlay-merged label (now on disk) is preserved as a user edit.
    expect(raw.llm.profiles.balanced.label).toBe("Overlay Balanced");
    expect(raw.llm.activeProfile).toBe("balanced");
  });

  test("quarantines corrupt config before merging hatch overlay", async () => {
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
    managedFetchResult = {
      status: "ok",
      profiles: allManagedProfileFixtures(),
    };

    await mergeDefaultConfigAndSeedInferenceProfiles();

    const quarantined = readdirSync(WORKSPACE_DIR).filter((n) =>
      n.startsWith("config.json.corrupt-"),
    );
    expect(quarantined.length).toBeGreaterThan(0);

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.default).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    // Off-platform hatch: user profiles are active.
    expect(raw.llm.activeProfile).toBe("custom-balanced");
    expect(raw.llm.profiles["custom-balanced"].provider).toBe("anthropic");
    expect(raw.llm.profiles.balanced.model).toBe("claude-sonnet-4-6");
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
// Tests: resolver survives managed-profile pruning. Internal call sites name
// `balanced` / `cost-optimized`; when those managed profiles are absent the
// resolver's `effectiveDefault` falls back to the `custom-*` sibling (or, if
// that is missing too, strips the profile and inherits `llm.default`). This
// locks in that pruning managed profiles never breaks internal calls.
// ---------------------------------------------------------------------------

describe("resolveCallSiteConfig with managed profiles absent", () => {
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
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    }
    ensureTestDir();
    setStorePathForTesting(join(WORKSPACE_DIR, "keys.enc"));
    delete process.env.IS_PLATFORM;
    invalidateConfigCache();
  });

  afterEach(() => {
    setStorePathForTesting(null);
    delete process.env.IS_PLATFORM;
    invalidateConfigCache();
  });

  function writeCustomProfilesOnlyConfig(): void {
    // No managed profiles on disk — only the personal custom-* siblings and
    // a workspace default. Mirrors a pruned (off-platform) install.
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        activeProfile: "custom-balanced",
        profiles: {
          auto: { source: "managed", label: "Auto" },
          "custom-balanced": {
            source: "user",
            provider: "anthropic",
            provider_connection: "anthropic-personal",
            model: "claude-sonnet-4-6",
          },
          "custom-cost-optimized": {
            source: "user",
            provider: "anthropic",
            provider_connection: "anthropic-personal",
            model: "claude-haiku-4-5-20251001",
          },
        },
      },
    });
  }

  test("cost-optimized call site resolves to custom-cost-optimized", () => {
    writeCustomProfilesOnlyConfig();
    const config = loadConfig();
    const resolved = resolveCallSiteConfig("memoryExtraction", config.llm);
    expect(resolved.model).toBe("claude-haiku-4-5-20251001");
    expect(resolved.provider).toBe("anthropic");
  });

  test("balanced call site resolves to custom-balanced", () => {
    writeCustomProfilesOnlyConfig();
    const config = loadConfig();
    const resolved = resolveCallSiteConfig("subagentSpawn", config.llm);
    expect(resolved.model).toBe("claude-sonnet-4-6");
    expect(resolved.provider).toBe("anthropic");
  });
});

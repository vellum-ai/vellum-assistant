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
import { _setStorePath } from "../security/encrypted-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n");
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
    const updatesPath = join(WORKSPACE_DIR, "UPDATES.md");
    if (existsSync(updatesPath)) rmSync(updatesPath, { force: true });
    ensureTestDir();
    _setStorePath(join(WORKSPACE_DIR, "keys.enc"));
    delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
    invalidateConfigCache();
  });

  afterEach(() => {
    _setStorePath(null);
    delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
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

  test("hatch default overlay does not suppress first-load inference profiles", () => {
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

    seedInferenceProfiles();
    mergeDefaultWorkspaceConfig();
    const config = loadConfig();

    expect(config.llm.default.provider).toBe("anthropic");
    expect(config.llm.default.model).toBe("claude-opus-4-7");
    expect(config.llm.activeProfile).toBe("balanced");
    expect(config.llm.profiles.balanced?.model).toBe("claude-sonnet-4-6");

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.default).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(raw.llm.activeProfile).toBe("balanced");
    expect(raw.llm.profiles.balanced.model).toBe("claude-sonnet-4-6");
  });

  test("non-Anthropic hatch overlay does not activate Anthropic managed profile", () => {
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
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    seedInferenceProfiles();
    mergeDefaultWorkspaceConfig();
    const config = loadConfig();
    const mainAgentConfig = resolveCallSiteConfig("mainAgent", config.llm);

    expect(config.llm.default.provider).toBe("openai");
    expect(config.llm.default.model).toBe("gpt-5.4");
    expect(config.llm.activeProfile).toBeUndefined();
    expect(config.llm.profiles.balanced?.provider).toBeUndefined();
    expect(mainAgentConfig.provider).toBe("openai");
    expect(mainAgentConfig.model).toBe("gpt-5.4");

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.default).toEqual({
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(raw.llm.activeProfile).toBeUndefined();
    expect(raw.llm.profiles.balanced).toEqual({});
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

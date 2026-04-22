import {
  existsSync,
  mkdirSync,
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

import {
  deepMergeMissing,
  deepMergeOverwrite,
  invalidateConfigCache,
  loadConfig,
} from "../config/loader.js";
import { _setStorePath } from "../security/encrypted-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n");
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

// ---------------------------------------------------------------------------
// Tests: deepMergeMissing (unit)
// ---------------------------------------------------------------------------

describe("deepMergeMissing", () => {
  test("adds missing top-level keys", () => {
    const target: Record<string, unknown> = { a: 1 };
    const defaults: Record<string, unknown> = { a: 99, b: 2 };
    const changed = deepMergeMissing(target, defaults);
    expect(changed).toBe(true);
    expect(target).toEqual({ a: 1, b: 2 });
  });

  test("does not overwrite existing values", () => {
    const target: Record<string, unknown> = { a: 1, b: "user" };
    const defaults: Record<string, unknown> = { a: 99, b: "default" };
    const changed = deepMergeMissing(target, defaults);
    expect(changed).toBe(false);
    expect(target).toEqual({ a: 1, b: "user" });
  });

  test("recursively fills nested objects", () => {
    const target: Record<string, unknown> = {
      nested: { existingKey: "keep" },
    };
    const defaults: Record<string, unknown> = {
      nested: { existingKey: "default", newKey: 42 },
    };
    const changed = deepMergeMissing(target, defaults);
    expect(changed).toBe(true);
    expect(target).toEqual({
      nested: { existingKey: "keep", newKey: 42 },
    });
  });

  test("returns false when no changes needed", () => {
    const target: Record<string, unknown> = { a: 1, b: { c: 3 } };
    const defaults: Record<string, unknown> = { a: 99, b: { c: 100 } };
    const changed = deepMergeMissing(target, defaults);
    expect(changed).toBe(false);
  });

  test("does not merge arrays", () => {
    const target: Record<string, unknown> = { items: [1, 2] };
    const defaults: Record<string, unknown> = { items: [3, 4, 5] };
    const changed = deepMergeMissing(target, defaults);
    expect(changed).toBe(false);
    expect(target).toEqual({ items: [1, 2] });
  });

  test("adds entire missing nested section", () => {
    const target: Record<string, unknown> = {};
    const defaults: Record<string, unknown> = {
      slack: { deliverAuthBypass: false },
    };
    const changed = deepMergeMissing(target, defaults);
    expect(changed).toBe(true);
    expect(target).toEqual({ slack: { deliverAuthBypass: false } });
  });
});

// ---------------------------------------------------------------------------
// Tests: deepMergeOverwrite (unit) — JSON-null-as-deletion semantics
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
// Tests: startup backfill integration
// ---------------------------------------------------------------------------

describe("config loader backfill", () => {
  beforeEach(() => {
    ensureTestDir();
    const resetPaths = [
      CONFIG_PATH,
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
    _setStorePath(join(WORKSPACE_DIR, "keys.enc"));
    invalidateConfigCache();
  });

  afterEach(() => {
    _setStorePath(null);
    invalidateConfigCache();
  });

  test("backfills missing schema keys into existing config.json", () => {
    // Write a minimal config that is missing many sections
    writeConfig({ provider: "anthropic", model: "claude-opus-4-6" });

    loadConfig();

    // Re-read the file from disk — it should have been backfilled
    const raw = readConfig();
    // New fields from this PR should be present
    expect(raw.telegram).toBeDefined();
    expect((raw.telegram as Record<string, unknown>).apiBaseUrl).toBe(
      "https://api.telegram.org",
    );
    expect((raw.telegram as Record<string, unknown>).deliverAuthBypass).toBe(
      false,
    );
    expect((raw.telegram as Record<string, unknown>).timeoutMs).toBe(15_000);
    expect((raw.telegram as Record<string, unknown>).maxRetries).toBe(3);
    expect((raw.telegram as Record<string, unknown>).initialBackoffMs).toBe(
      1_000,
    );

    expect(raw.whatsapp).toBeDefined();
    expect((raw.whatsapp as Record<string, unknown>).deliverAuthBypass).toBe(
      false,
    );
    expect((raw.whatsapp as Record<string, unknown>).timeoutMs).toBe(15_000);
    expect((raw.whatsapp as Record<string, unknown>).maxRetries).toBe(3);
    expect((raw.whatsapp as Record<string, unknown>).initialBackoffMs).toBe(
      1_000,
    );

    expect(raw.slack).toBeDefined();
    expect((raw.slack as Record<string, unknown>).deliverAuthBypass).toBe(
      false,
    );
  });

  test("preserves existing user-defined values during backfill", () => {
    writeConfig({
      services: {
        inference: { provider: "openai", model: "gpt-4" },
      },
      telegram: { botUsername: "mybot", timeoutMs: 30_000 },
      whatsapp: { phoneNumber: "+1234567890" },
    });

    loadConfig();

    const raw = readConfig();
    // User values preserved
    const services = raw.services as Record<string, Record<string, unknown>>;
    expect(services.inference.provider).toBe("openai");
    expect(services.inference.model).toBe("gpt-4");
    expect((raw.telegram as Record<string, unknown>).botUsername).toBe("mybot");
    expect((raw.telegram as Record<string, unknown>).timeoutMs).toBe(30_000);
    expect((raw.whatsapp as Record<string, unknown>).phoneNumber).toBe(
      "+1234567890",
    );

    // Missing fields backfilled
    expect((raw.telegram as Record<string, unknown>).apiBaseUrl).toBe(
      "https://api.telegram.org",
    );
    expect((raw.telegram as Record<string, unknown>).deliverAuthBypass).toBe(
      false,
    );
    expect((raw.whatsapp as Record<string, unknown>).deliverAuthBypass).toBe(
      false,
    );
  });

  test("does not rewrite config.json when no effective change exists", () => {
    // First load: creates config from scratch with all defaults
    loadConfig();
    invalidateConfigCache();

    // Read file and record its content
    const contentBefore = readFileSync(CONFIG_PATH, "utf-8");

    // Second load: file already has all keys — no write expected
    loadConfig();

    const contentAfter = readFileSync(CONFIG_PATH, "utf-8");
    expect(contentAfter).toBe(contentBefore);
  });

  test("does not write dataDir during backfill", () => {
    writeConfig({ provider: "anthropic" });

    loadConfig();

    const raw = readConfig();
    expect(raw.dataDir).toBeUndefined();
  });

  test("backfills new nested fields into existing sections", () => {
    // Config with only the old telegram.botUsername field
    writeConfig({
      telegram: { botUsername: "oldbot" },
    });

    loadConfig();

    const raw = readConfig();
    const telegram = raw.telegram as Record<string, unknown>;
    // Old field preserved
    expect(telegram.botUsername).toBe("oldbot");
    // New fields backfilled
    expect(telegram.apiBaseUrl).toBe("https://api.telegram.org");
    expect(telegram.deliverAuthBypass).toBe(false);
    expect(telegram.timeoutMs).toBe(15_000);
    expect(telegram.maxRetries).toBe(3);
    expect(telegram.initialBackoffMs).toBe(1_000);
  });
});

/**
 * A corrupt config.json (truncated during a power-loss mid-write, or
 * hand-edited to invalid JSON) is quarantined by the loader, which
 * logs an error with a remediation hint and falls through to the
 * default-config path so startup proceeds. These tests verify that
 * loadConfig() / loadRawConfig() / getConfigReadOnly() never throw on
 * corrupt input, and that the corrupt file is preserved for debugging
 * (quarantined by the writing loaders; left in place by the read-only
 * accessor).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getConfigReadOnly,
  invalidateConfigCache,
  loadConfig,
  loadRawConfig,
} from "../config/loader.js";
import { setStorePathForTesting } from "./encrypted-store-test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
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

function resetWorkspace(): void {
  for (const name of readdirSync(WORKSPACE_DIR)) {
    rmSync(join(WORKSPACE_DIR, name), { recursive: true, force: true });
  }
  ensureTestDir();
}

function listQuarantinedFiles(): string[] {
  return readdirSync(WORKSPACE_DIR).filter((name) =>
    /^config\.json\.corrupt-.+\.json$/.test(name),
  );
}

/** Sorted recursive listing of every path under the workspace dir. */
function snapshotWorkspaceTree(): string[] {
  return readdirSync(WORKSPACE_DIR, { recursive: true }).map(String).sort();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadConfig corrupt-file recovery", () => {
  beforeEach(() => {
    resetWorkspace();
    setStorePathForTesting(join(WORKSPACE_DIR, "keys.enc"));
    invalidateConfigCache();
  });

  afterEach(() => {
    setStorePathForTesting(null);
    invalidateConfigCache();
  });

  test("quarantines corrupt config.json and returns defaults", () => {
    // Simulate a truncated mid-write: valid JSON prefix, abrupt end.
    writeFileSync(CONFIG_PATH, '{"provider": "anthropic", "mo');

    // Must not throw — the daemon must never block startup on corrupt config.
    const config = loadConfig();

    // Defaults loaded — config is populated through the Zod schema.
    expect(config).toBeDefined();
    expect(config.memory).toBeDefined();

    // Corrupt file renamed, not deleted — content preserved for debug.
    const quarantined = listQuarantinedFiles();
    expect(quarantined).toHaveLength(1);
    const quarantinedPath = join(WORKSPACE_DIR, quarantined[0]);
    expect(readFileSync(quarantinedPath, "utf-8")).toBe(
      '{"provider": "anthropic", "mo',
    );

    // After quarantine the daemon wrote a fresh default config.json.
    expect(existsSync(CONFIG_PATH)).toBe(true);
  });

  test("loads a valid config without renaming (regression guard)", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ provider: "anthropic", model: "claude-opus-4-7" }),
    );

    const config = loadConfig();
    expect(config).toBeDefined();

    // No quarantine file for valid JSON.
    expect(listQuarantinedFiles()).toHaveLength(0);
    // The original file is still present.
    expect(existsSync(CONFIG_PATH)).toBe(true);
  });

  test("does not re-quarantine existing quarantine files on subsequent startups", () => {
    // First startup: corrupt config is quarantined.
    writeFileSync(CONFIG_PATH, "}{not json");
    loadConfig();

    const firstBatch = listQuarantinedFiles();
    expect(firstBatch).toHaveLength(1);

    // Daemon restart with no new config.json (the loader wrote defaults after
    // the quarantine on the previous load, so there IS now a valid config.json
    // on disk — no second quarantine should occur).
    invalidateConfigCache();
    loadConfig();

    // Still exactly one quarantined file — the loader did not re-rename a
    // pristine or already-quarantined file.
    expect(listQuarantinedFiles()).toHaveLength(1);
    expect(listQuarantinedFiles()[0]).toBe(firstBatch[0]);
  });

  test("quarantine filenames are filesystem-safe (no colons)", () => {
    writeFileSync(CONFIG_PATH, "not-valid-json");
    loadConfig();

    const quarantined = listQuarantinedFiles();
    expect(quarantined).toHaveLength(1);
    // ISO-8601 colons must have been replaced — filenames with `:` are
    // invalid on Windows and awkward on macOS Finder.
    expect(quarantined[0]).not.toContain(":");
    // Should match the documented shape: config.json.corrupt-<ISO>.json
    expect(quarantined[0]).toMatch(
      /^config\.json\.corrupt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/,
    );
  });

  // ---------------------------------------------------------------------------
  // Shape-mismatch quarantine — same JSON.parse caveat as `loadRawConfig`.
  // Without an `isPlainObject` check, downstream code (e.g. the managed-Gemini
  // `setNestedValue` block in `loadConfig`) would TypeError on `null` or
  // primitive `fileConfig`, and only the broad try/catch around the migration
  // saved startup. Treating the wrong-shape case as a parse error here moves
  // the boundary check to the loader so callers don't have to defend.
  // ---------------------------------------------------------------------------

  test.each([
    ["null at the top level", "null"],
    ["a JSON number", "42"],
    ["a JSON string", '"hello"'],
    ["a JSON boolean", "true"],
    ["a JSON array", '["provider", "anthropic"]'],
  ])(
    "quarantines when config.json contains %s and returns defaults",
    (_label, jsonText) => {
      writeFileSync(CONFIG_PATH, jsonText);

      // Must not throw — daemon startup contract.
      const config = loadConfig();

      // Defaults loaded — config is populated through the Zod schema.
      expect(config).toBeDefined();
      expect(config.memory).toBeDefined();

      const quarantined = listQuarantinedFiles();
      expect(quarantined).toHaveLength(1);
      // Original wrong-shape content preserved for debugging.
      expect(readFileSync(join(WORKSPACE_DIR, quarantined[0]), "utf-8")).toBe(
        jsonText,
      );
    },
  );
});

describe("loadRawConfig corrupt-file recovery", () => {
  beforeEach(() => {
    resetWorkspace();
    setStorePathForTesting(join(WORKSPACE_DIR, "keys.enc"));
    invalidateConfigCache();
  });

  afterEach(() => {
    setStorePathForTesting(null);
    invalidateConfigCache();
  });

  test("returns {} and quarantines corrupt file instead of throwing", () => {
    writeFileSync(CONFIG_PATH, "this is not json at all");

    // Must not throw — the /v1/config handler depends on this.
    const raw = loadRawConfig();

    expect(raw).toEqual({});
    expect(listQuarantinedFiles()).toHaveLength(1);
  });

  test("returns parsed object when config is valid", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ foo: "bar", nested: { k: 1 } }),
    );

    const raw = loadRawConfig();
    expect(raw).toEqual({ foo: "bar", nested: { k: 1 } });
    expect(listQuarantinedFiles()).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Shape-mismatch quarantine — JSON.parse can succeed on `null`, primitives,
  // and arrays, all of which violate the function's `Record<string, unknown>`
  // return-type contract. These cases must be quarantined the same way as a
  // syntax error so callers (e.g. /v1/config handlers) can iterate the result
  // safely without runtime shape checks.
  // ---------------------------------------------------------------------------

  test.each([
    ["null at the top level", "null"],
    ["a JSON number", "42"],
    ["a JSON string", '"hello"'],
    ["a JSON boolean", "true"],
    ["a JSON array", '["provider", "anthropic"]'],
  ])(
    "quarantines when config.json contains %s and returns {}",
    (_label, jsonText) => {
      writeFileSync(CONFIG_PATH, jsonText);

      // Must not throw — same contract as the syntax-error path.
      const raw = loadRawConfig();

      expect(raw).toEqual({});
      const quarantined = listQuarantinedFiles();
      expect(quarantined).toHaveLength(1);
      // Original wrong-shape content is preserved for debugging.
      expect(readFileSync(join(WORKSPACE_DIR, quarantined[0]), "utf-8")).toBe(
        jsonText,
      );
    },
  );
});

describe("getConfigReadOnly corrupt-file recovery", () => {
  beforeEach(() => {
    resetWorkspace();
    setStorePathForTesting(join(WORKSPACE_DIR, "keys.enc"));
    invalidateConfigCache();
  });

  afterEach(() => {
    setStorePathForTesting(null);
    invalidateConfigCache();
  });

  test("returns defaults on unparseable config.json without side effects", () => {
    writeFileSync(CONFIG_PATH, '{"provider": "anthropic", "mo');

    // Must not throw — this runs during CLI program construction.
    const config = getConfigReadOnly();

    expect(config).toBeDefined();
    expect(config.memory).toBeDefined();
    expect(listQuarantinedFiles()).toHaveLength(0);
    expect(readFileSync(CONFIG_PATH, "utf-8")).toBe(
      '{"provider": "anthropic", "mo',
    );
  });

  // ---------------------------------------------------------------------------
  // Top-level shape guard — JSON.parse succeeds on `null`, primitives, and
  // arrays, but `validateWithBuiltinProfiles` requires a plain-object root
  // (its profile merge would TypeError otherwise). The read-only accessor
  // must fall back to defaults like the parse-error path, and — unlike
  // loadConfig() — must NOT quarantine: it stays side-effect-free.
  // ---------------------------------------------------------------------------

  test.each([
    ["null at the top level", "null"],
    ["a JSON number", "42"],
    ["a JSON string", '"hello"'],
    ["a JSON boolean", "true"],
    ["a JSON array", '["provider", "anthropic"]'],
  ])(
    "returns defaults when config.json contains %s, without quarantining",
    (_label, jsonText) => {
      writeFileSync(CONFIG_PATH, jsonText);
      // The contract also covers the logs dir: the shared `log` is a lazy
      // proxy whose first call creates `data/logs/` and the day's log file,
      // so this code path must not log at all. (Under BUN_TEST the logger
      // routes to stderr, so the snapshot below can't observe a logger
      // regression directly — it guards every other filesystem side effect
      // and documents the contract.)
      rmSync(join(WORKSPACE_DIR, "data", "logs"), {
        recursive: true,
        force: true,
      });
      const before = snapshotWorkspaceTree();

      // Must not throw — CLI program construction depends on this.
      const config = getConfigReadOnly();

      expect(config).toBeDefined();
      expect(config.memory).toBeDefined();
      expect(listQuarantinedFiles()).toHaveLength(0);
      expect(readFileSync(CONFIG_PATH, "utf-8")).toBe(jsonText);
      // Side-effect-free: nothing anywhere in the workspace was created,
      // removed, or renamed — no quarantine, no default-config write, no
      // data/ or logs dirs.
      expect(existsSync(join(WORKSPACE_DIR, "data", "logs"))).toBe(false);
      expect(snapshotWorkspaceTree()).toEqual(before);
    },
  );

  test("returns the parsed config when config.json is a valid object", () => {
    const customDataDir = join(WORKSPACE_DIR, "custom-data");
    writeFileSync(CONFIG_PATH, JSON.stringify({ dataDir: customDataDir }));

    const config = getConfigReadOnly();
    expect(config.dataDir).toBe(customDataDir);
    expect(listQuarantinedFiles()).toHaveLength(0);
  });
});

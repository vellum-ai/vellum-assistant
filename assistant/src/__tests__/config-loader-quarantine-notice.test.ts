/**
 * When loadConfig()/loadRawConfig() quarantines a corrupt config.json, it
 * writes a small JSON sentinel to <workspace>/data/config-quarantine-notice.json
 * recording the event. The per-turn `config-quarantine-notice` injector reads
 * that sentinel and surfaces the reset to the agent — it's agent-visible
 * context, not a push notification.
 *
 * The sentinel is overwritten on each quarantine (idempotent per event) and
 * resolves from a workspace-derived path so it is safe to write during the
 * very early config load, before the SQLite DB or getConfig().dataDir exist.
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
  _writeQuarantineNotice,
  invalidateConfigCache,
  loadConfig,
} from "../config/loader.js";
import { getConfigQuarantineNoticePath } from "../util/platform.js";
import { setStorePathForTesting } from "./encrypted-store-test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");
const NOTICE_PATH = getConfigQuarantineNoticePath();

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

function readNotice(): {
  quarantinedAt: string;
  quarantinePath: string;
  originalPath: string;
} {
  return JSON.parse(readFileSync(NOTICE_PATH, "utf-8"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("config-quarantine notice sentinel", () => {
  beforeEach(() => {
    resetWorkspace();
    setStorePathForTesting(join(WORKSPACE_DIR, "keys.enc"));
    invalidateConfigCache();
  });

  afterEach(() => {
    setStorePathForTesting(null);
    invalidateConfigCache();
  });

  test("writes a sentinel recording the quarantine when config.json is corrupt", () => {
    writeFileSync(CONFIG_PATH, '{"provider": "anthropic", "mo');

    loadConfig();

    const [quarantinedName] = listQuarantinedFiles();
    expect(quarantinedName).toBeDefined();
    const quarantinedPath = join(WORKSPACE_DIR, quarantinedName);

    expect(existsSync(NOTICE_PATH)).toBe(true);
    const notice = readNotice();
    expect(notice.quarantinePath).toBe(quarantinedPath);
    expect(notice.originalPath).toBe(CONFIG_PATH);
    // quarantinedAt is a parseable ISO timestamp.
    expect(Number.isNaN(Date.parse(notice.quarantinedAt))).toBe(false);
  });

  test("a second quarantine overwrites the sentinel with the latest event", () => {
    // First corruption round.
    writeFileSync(CONFIG_PATH, '{"partial": ');
    loadConfig();
    invalidateConfigCache();

    const firstNotice = readNotice();
    expect(listQuarantinedFiles()).toHaveLength(1);

    // Loader wrote a fresh default config.json after quarantine; corrupt it
    // again. Spin briefly so the second quarantine gets a distinct
    // millisecond-precision filename (and a later timestamp).
    const untilDifferentMs = Date.now() + 5;
    while (Date.now() < untilDifferentMs) {
      /* spin */
    }
    writeFileSync(CONFIG_PATH, "still not json");
    loadConfig();

    const quarantined = listQuarantinedFiles().sort();
    expect(quarantined).toHaveLength(2);

    // Single sentinel, pointing at the most recent quarantine.
    const secondNotice = readNotice();
    expect(secondNotice.quarantinePath).not.toBe(firstNotice.quarantinePath);
    expect(secondNotice.quarantinePath).toBe(
      join(WORKSPACE_DIR, quarantined[quarantined.length - 1]),
    );
  });

  test("valid config.json does not create a sentinel (regression guard)", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ provider: "anthropic", model: "claude-opus-4-7" }),
    );

    loadConfig();

    expect(listQuarantinedFiles()).toHaveLength(0);
    expect(existsSync(NOTICE_PATH)).toBe(false);
  });

  test("sentinel write failure is swallowed (startup never blocks)", () => {
    // Make the notice directory unwritable by replacing it with a file so the
    // write/mkdir path throws. The helper must not propagate the error.
    const noticeDir = join(WORKSPACE_DIR, "data");
    rmSync(noticeDir, { recursive: true, force: true });
    // A regular file where the `data` directory is expected makes mkdir/write
    // fail with ENOTDIR/EEXIST.
    writeFileSync(noticeDir, "not a directory", "utf-8");

    const quarantinePath = join(
      WORKSPACE_DIR,
      "config.json.corrupt-2026-04-20T12-00-00.000Z.json",
    );

    expect(() =>
      _writeQuarantineNotice(CONFIG_PATH, quarantinePath),
    ).not.toThrow();
  });
});

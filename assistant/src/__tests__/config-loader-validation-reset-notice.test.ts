/**
 * When loadConfig() parses config.json as valid JSON but schema validation
 * fails so hard that the loader falls back to *full* defaults (via
 * cloneDefaultConfig), it writes a JSON sentinel to
 * <workspace>/data/config-validation-reset-notice.json recording the reset.
 * The per-turn `config-validation-reset-notice` injector surfaces that event to
 * the agent so a setting that silently reverted (e.g. a managed Outlook/OAuth
 * service mode) becomes explainable — matching LUM-2758.
 *
 * The revealing case: an unknown `llm.callSites` key produces a Zod
 * `invalid_key` that aborts the record parse and *masks* the LLM
 * `superRefine` on the first pass, so only the invalid-key warning logs. The
 * loader strips the unknown key and re-parses, which unmasks a latent
 * `superRefine` violation (here an `activeProfile` referencing a profile that
 * doesn't exist); the retry fails and the whole config resets to defaults.
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

import { invalidateConfigCache, loadConfig } from "../config/loader.js";
import { getConfigValidationResetNoticePath } from "../util/platform.js";
import { setStorePathForTesting } from "./encrypted-store-test-helpers.js";

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");
const NOTICE_PATH = getConfigValidationResetNoticePath();

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

function readNotice(): { resetAt: string; invalidPaths: string[] } {
  return JSON.parse(readFileSync(NOTICE_PATH, "utf-8"));
}

/**
 * A config.json that parses as JSON but forces the full-defaults fallback: the
 * unknown `llm.callSites.proactiveArtifactDecision` key masks the LLM
 * superRefine on the first parse, and stripping it unmasks the invalid
 * `activeProfile` on the retry, which then fails.
 */
function writeFullResetConfig(): void {
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      {
        provider: "anthropic",
        model: "claude-opus-4-7",
        llm: {
          activeProfile: "ghostActive",
          callSites: {
            proactiveArtifactDecision: { profile: "cost-optimized" },
          },
        },
      },
      null,
      2,
    ),
  );
}

describe("config-validation-reset notice sentinel", () => {
  beforeEach(() => {
    resetWorkspace();
    setStorePathForTesting(join(WORKSPACE_DIR, "keys.enc"));
    invalidateConfigCache();
  });

  afterEach(() => {
    setStorePathForTesting(null);
    invalidateConfigCache();
  });

  test("writes a sentinel when validation falls back to full defaults", () => {
    writeFullResetConfig();

    loadConfig();

    expect(existsSync(NOTICE_PATH)).toBe(true);
    const notice = readNotice();
    expect(Number.isNaN(Date.parse(notice.resetAt))).toBe(false);
    // Records both the masking unknown key and the unmasked retry violation.
    expect(notice.invalidPaths).toContain("llm.activeProfile");
    expect(notice.invalidPaths).toContain(
      "llm.callSites.proactiveArtifactDecision",
    );
    // The on-disk config is left intact for recovery — not quarantined/rewritten.
    expect(existsSync(CONFIG_PATH)).toBe(true);
  });

  test("valid config.json does not create a sentinel (regression guard)", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ provider: "anthropic", model: "claude-opus-4-7" }),
    );

    loadConfig();

    expect(existsSync(NOTICE_PATH)).toBe(false);
  });

  test("a later clean load clears a stale reset sentinel", () => {
    // First: force a reset so the sentinel exists.
    writeFullResetConfig();
    loadConfig();
    expect(existsSync(NOTICE_PATH)).toBe(true);
    invalidateConfigCache();

    // Then: the user fixes the config (removes the bad entries). The next load
    // validates cleanly, so the notice must be cleared rather than lingering.
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ provider: "anthropic", model: "claude-opus-4-7" }),
    );
    loadConfig();

    expect(existsSync(NOTICE_PATH)).toBe(false);
  });
});

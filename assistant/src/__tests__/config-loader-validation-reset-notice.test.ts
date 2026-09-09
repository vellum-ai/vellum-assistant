/**
 * When loadConfig() parses config.json as valid JSON but schema validation
 * fails so hard that the loader falls back to *full* defaults (via
 * cloneDefaultConfig), it writes a JSON sentinel to
 * <workspace>/data/config-validation-reset-notice.json recording the reset.
 * The per-turn `config-validation-reset-notice` injector surfaces that event to
 * the agent so a setting that silently reverted (e.g. a managed Outlook/OAuth
 * service mode) becomes explainable — matching LUM-2758.
 *
 * The revealing case: a wrong-type `llm.profiles` fails the first parse so
 * `superRefine` never runs. The loader strips it and re-parses, which unmasks
 * a latent `activeProfile` / call-site reference to a profile that does not
 * exist; the retry fails and the whole config resets to defaults.
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
  invalidateConfigCache,
  loadConfig,
  withSuppressedConfigDiskWritesSync,
} from "../config/loader.js";
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
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
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
 * A config.json that parses as JSON but forces the salvage ladder: a
 * wrong-type `llm.profiles` fails the first parse (so superRefine never
 * runs), and stripping it unmasks ghost `activeProfile` / call-site refs
 * on the retry.
 */
function writeFullResetConfig(): void {
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      {
        provider: "anthropic",
        model: "claude-opus-4-7",
        llm: {
          profiles: "not-an-object",
          activeProfile: "ghostActive",
          callSites: {
            mainAgent: { profile: "ghostActive" },
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
    // Records both the first-parse type error and the unmasked retry violation.
    expect(notice.invalidPaths).toContain("llm.activeProfile");
    expect(notice.invalidPaths).toContain("llm.profiles");
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

  test("writes the sentinel even under suppressed disk writes (config-set path)", () => {
    // `commitConfigWrite` re-parses via getConfig() inside
    // withSuppressedConfigDiskWrites *after* persisting the new config, then
    // caches the fallback against the invalid file signature so later loads
    // short-circuit. If the sentinel isn't written during this suppressed load,
    // the live-session reset the user just caused stays silent until a restart.
    writeFullResetConfig();
    invalidateConfigCache();

    withSuppressedConfigDiskWritesSync(() => loadConfig());

    expect(existsSync(NOTICE_PATH)).toBe(true);
    expect(readNotice().invalidPaths).toContain("llm.activeProfile");
  });

  test("clears the sentinel under suppressed disk writes when the fix lands (config-set path)", () => {
    // First cause a reset so the sentinel exists.
    writeFullResetConfig();
    loadConfig();
    expect(existsSync(NOTICE_PATH)).toBe(true);
    invalidateConfigCache();

    // The user fixes the config; the recovery re-parse runs under suppression
    // (commitConfigWrite) and caches the clean config against the new signature.
    // The notice must be cleared here, or short-circuiting loads keep injecting
    // it for up to seven days after recovery.
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ provider: "anthropic", model: "claude-opus-4-7" }),
    );
    withSuppressedConfigDiskWritesSync(() => loadConfig());

    expect(existsSync(NOTICE_PATH)).toBe(false);
  });

  test("unknown call-site keys with a defined profile do not write a sentinel", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          llm: {
            profiles: {
              "glm-default": {
                provider: "vellum",
                model: "accounts/fireworks/models/glm-5p2",
              },
            },
            activeProfile: "glm-default",
            callSites: {
              mainAgent: { profile: "glm-default" },
              proactiveArtifactDecision: { profile: "glm-default" },
              meetConsentMonitor: { profile: "glm-default" },
            },
          },
        },
        null,
        2,
      ),
    );

    const config = loadConfig();

    expect(existsSync(NOTICE_PATH)).toBe(false);
    expect(config.llm.activeProfile).toBe("glm-default");
    expect(config.llm.callSites.mainAgent?.profile).toBe("glm-default");
    expect(config.llm.profiles["glm-default"]?.model).toBe(
      "accounts/fireworks/models/glm-5p2",
    );
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

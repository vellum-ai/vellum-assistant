/**
 * Coverage for `checkUnrecognizedEnvVars()` — the source of the
 * `[env] Unrecognized environment variable: ...` warning emitted by
 * `validateEnv()` at daemon startup.
 *
 * Regression target: a known VELLUM_* env var (set by hatch / statefulset /
 * docker / local launchers) was firing a startup WARN because it was missing
 * from the registry's `KNOWN_VELLUM_VARS` allowlist.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { checkUnrecognizedEnvVars } from "../env-registry.js";

describe("checkUnrecognizedEnvVars", () => {
  const originalEnv = { ...process.env };
  const sentinelKeys: string[] = [];

  beforeEach(() => {
    // Drop any VELLUM_* keys so each test starts from a clean slate.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("VELLUM_")) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    for (const key of sentinelKeys) {
      delete process.env[key];
    }
    sentinelKeys.length = 0;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("VELLUM_")) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (key.startsWith("VELLUM_") && value !== undefined) {
        process.env[key] = value;
      }
    }
  });

  test("returns empty list when no VELLUM_* env vars are set", () => {
    expect(checkUnrecognizedEnvVars()).toEqual([]);
  });

  test("recognizes VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH", () => {
    // Set by `cli/src/commands/hatch.ts`, `cli/src/lib/local.ts`,
    // `cli/src/lib/statefulset.ts`, and `cli/src/lib/docker.ts` to point at
    // a JSON overlay the daemon merges into the workspace config.
    sentinelKeys.push("VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH");
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH =
      "/tmp/vellum-initial-config.json";

    expect(checkUnrecognizedEnvVars()).toEqual([]);
  });

  test("flags an unknown VELLUM_* variable", () => {
    sentinelKeys.push("VELLUM_TOTALLY_MADE_UP_VARIABLE");
    process.env.VELLUM_TOTALLY_MADE_UP_VARIABLE = "1";

    expect(checkUnrecognizedEnvVars()).toEqual([
      "Unrecognized environment variable: VELLUM_TOTALLY_MADE_UP_VARIABLE",
    ]);
  });

  test("ignores non-VELLUM_ environment variables", () => {
    sentinelKeys.push("FOO_TOTALLY_MADE_UP");
    process.env.FOO_TOTALLY_MADE_UP = "1";

    expect(checkUnrecognizedEnvVars()).toEqual([]);
  });
});

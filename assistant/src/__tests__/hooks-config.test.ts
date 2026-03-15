import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Set BASE_DATA_DIR before importing modules that use getRootDir()
const testDir = join(tmpdir(), `hooks-config-test-${Date.now()}`);
process.env.BASE_DATA_DIR = testDir;

import {
  ensureHookInConfig,
  isHookEnabled,
  loadHooksConfig,
  saveHooksConfig,
  setHookEnabled,
} from "../hooks/config.js";

describe("Hooks Config", () => {
  beforeEach(() => {
    const hooksDir = join(testDir, ".vellum", "hooks");
    mkdirSync(hooksDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("loadHooksConfig returns defaults when no config file exists", () => {
    const config = loadHooksConfig();
    expect(config.version).toBe(1);
    expect(config.hooks).toEqual({});
  });

  test("loadHooksConfig reads existing config", () => {
    const configPath = join(testDir, ".vellum", "hooks", "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        hooks: { "my-hook": { enabled: true } },
      }),
    );

    const config = loadHooksConfig();
    expect(config.hooks["my-hook"].enabled).toBe(true);
  });

  test("loadHooksConfig returns defaults for invalid JSON", () => {
    const configPath = join(testDir, ".vellum", "hooks", "config.json");
    writeFileSync(configPath, "NOT VALID JSON {{{");

    const config = loadHooksConfig();
    expect(config.version).toBe(1);
    expect(config.hooks).toEqual({});
  });

  test("loadHooksConfig returns defaults for invalid structure", () => {
    const configPath = join(testDir, ".vellum", "hooks", "config.json");
    writeFileSync(configPath, JSON.stringify({ foo: "bar" }));

    const config = loadHooksConfig();
    expect(config.version).toBe(1);
    expect(config.hooks).toEqual({});
  });

  test("saveHooksConfig writes config to disk", () => {
    const config = { version: 1, hooks: { "test-hook": { enabled: true } } };
    saveHooksConfig(config);

    const configPath = join(testDir, ".vellum", "hooks", "config.json");
    expect(existsSync(configPath)).toBe(true);
    const read = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(read.hooks["test-hook"].enabled).toBe(true);
  });

  test("isHookEnabled returns false for unknown hook", () => {
    expect(isHookEnabled("nonexistent")).toBe(false);
  });

  test("setHookEnabled enables a hook", () => {
    setHookEnabled("my-hook", true);
    expect(isHookEnabled("my-hook")).toBe(true);
  });

  test("setHookEnabled disables a hook", () => {
    setHookEnabled("my-hook", true);
    setHookEnabled("my-hook", false);
    expect(isHookEnabled("my-hook")).toBe(false);
  });

  test("ensureHookInConfig adds hook if missing", () => {
    ensureHookInConfig("new-hook", { enabled: false });
    const config = loadHooksConfig();
    expect(config.hooks["new-hook"]).toEqual({ enabled: false });
  });

  test("ensureHookInConfig does not overwrite existing hook", () => {
    setHookEnabled("existing", true);
    ensureHookInConfig("existing", { enabled: false });
    expect(isHookEnabled("existing")).toBe(true);
  });
});

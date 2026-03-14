import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { saveHooksConfig } from "../hooks/config.js";
import { discoverHooks } from "../hooks/discovery.js";

// Set BASE_DATA_DIR before importing modules that use getRootDir()
const testDir = join(tmpdir(), `hooks-discovery-test-${Date.now()}`);
process.env.BASE_DATA_DIR = testDir;

function createHook(
  hooksDir: string,
  name: string,
  manifest: Record<string, unknown>,
  scriptContent = "#!/bin/bash\nexit 0",
): void {
  const hookDir = join(hooksDir, name);
  mkdirSync(hookDir, { recursive: true });
  writeFileSync(join(hookDir, "hook.json"), JSON.stringify(manifest));
  const scriptName = (manifest.script as string) ?? "run.sh";
  const scriptPath = join(hookDir, scriptName);
  writeFileSync(scriptPath, scriptContent);
  chmodSync(scriptPath, 0o755);
}

describe("Hooks Discovery", () => {
  let hooksDir: string;

  beforeEach(() => {
    hooksDir = join(testDir, ".vellum", "hooks");
    mkdirSync(hooksDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("returns empty array when no hooks exist", () => {
    const hooks = discoverHooks(hooksDir);
    expect(hooks).toEqual([]);
  });

  test("discovers a valid hook", () => {
    createHook(hooksDir, "my-hook", {
      name: "my-hook",
      description: "Test hook",
      version: "1.0.0",
      events: ["pre-tool-execute"],
      script: "run.sh",
    });

    const hooks = discoverHooks(hooksDir);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].name).toBe("my-hook");
    expect(hooks[0].manifest.events).toEqual(["pre-tool-execute"]);
    expect(hooks[0].enabled).toBe(false);
  });

  test("discovers multiple hooks sorted alphabetically", () => {
    createHook(hooksDir, "zebra-hook", {
      name: "zebra-hook",
      description: "Z hook",
      version: "1.0.0",
      events: ["on-error"],
      script: "run.sh",
    });
    createHook(hooksDir, "alpha-hook", {
      name: "alpha-hook",
      description: "A hook",
      version: "1.0.0",
      events: ["post-message"],
      script: "run.sh",
    });

    const hooks = discoverHooks(hooksDir);
    expect(hooks).toHaveLength(2);
    expect(hooks[0].name).toBe("alpha-hook");
    expect(hooks[1].name).toBe("zebra-hook");
  });

  test("skips directory without hook.json", () => {
    mkdirSync(join(hooksDir, "no-manifest"), { recursive: true });
    writeFileSync(
      join(hooksDir, "no-manifest", "run.sh"),
      "#!/bin/bash\nexit 0",
    );

    const hooks = discoverHooks(hooksDir);
    expect(hooks).toEqual([]);
  });

  test("skips hook with invalid JSON in manifest", () => {
    const hookDir = join(hooksDir, "bad-json");
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(join(hookDir, "hook.json"), "NOT JSON {{{");
    writeFileSync(join(hookDir, "run.sh"), "#!/bin/bash\nexit 0");

    const hooks = discoverHooks(hooksDir);
    expect(hooks).toEqual([]);
  });

  test("skips hook with missing required fields", () => {
    createHook(hooksDir, "missing-fields", {
      name: "missing-fields",
      // missing events and script
    });

    const hooks = discoverHooks(hooksDir);
    expect(hooks).toEqual([]);
  });

  test("skips hook with invalid event names", () => {
    createHook(hooksDir, "bad-events", {
      name: "bad-events",
      description: "Bad",
      version: "1.0.0",
      events: ["not-a-real-event"],
      script: "run.sh",
    });

    const hooks = discoverHooks(hooksDir);
    expect(hooks).toEqual([]);
  });

  test("skips hook with missing script file", () => {
    const hookDir = join(hooksDir, "no-script");
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(
      join(hookDir, "hook.json"),
      JSON.stringify({
        name: "no-script",
        description: "Missing script",
        version: "1.0.0",
        events: ["on-error"],
        script: "nonexistent.sh",
      }),
    );

    const hooks = discoverHooks(hooksDir);
    expect(hooks).toEqual([]);
  });

  test("respects enabled state from config", () => {
    createHook(hooksDir, "enabled-hook", {
      name: "enabled-hook",
      description: "Enabled",
      version: "1.0.0",
      events: ["pre-tool-execute"],
      script: "run.sh",
    });

    saveHooksConfig({
      version: 1,
      hooks: { "enabled-hook": { enabled: true } },
    });

    const hooks = discoverHooks(hooksDir);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].enabled).toBe(true);
  });

  test("defaults to disabled when not in config", () => {
    createHook(hooksDir, "unconfigured", {
      name: "unconfigured",
      description: "Not in config",
      version: "1.0.0",
      events: ["on-error"],
      script: "run.sh",
    });

    const hooks = discoverHooks(hooksDir);
    expect(hooks[0].enabled).toBe(false);
  });

  test("returns empty for nonexistent hooks directory", () => {
    const hooks = discoverHooks("/nonexistent/path");
    expect(hooks).toEqual([]);
  });

  test("skips non-directory entries", () => {
    writeFileSync(join(hooksDir, "some-file.txt"), "not a directory");

    createHook(hooksDir, "valid-hook", {
      name: "valid-hook",
      description: "Valid",
      version: "1.0.0",
      events: ["on-error"],
      script: "run.sh",
    });

    const hooks = discoverHooks(hooksDir);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].name).toBe("valid-hook");
  });

  test("hook with multiple events is discovered", () => {
    createHook(hooksDir, "multi-event", {
      name: "multi-event",
      description: "Multi",
      version: "1.0.0",
      events: ["pre-tool-execute", "post-tool-execute", "on-error"],
      script: "run.sh",
    });

    const hooks = discoverHooks(hooksDir);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].manifest.events).toHaveLength(3);
  });
});

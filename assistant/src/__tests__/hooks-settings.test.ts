import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Set BASE_DATA_DIR before importing modules that use getRootDir()
const testDir = join(tmpdir(), `hooks-settings-test-${Date.now()}`);
process.env.BASE_DATA_DIR = testDir;

import { getHookSettings } from "../hooks/config.js";
import { saveHooksConfig } from "../hooks/config.js";
import { runHookScript } from "../hooks/runner.js";
import type { DiscoveredHook, HookManifest } from "../hooks/types.js";

describe("Hook Settings", () => {
  let hooksDir: string;

  beforeEach(() => {
    hooksDir = join(testDir, ".vellum", "hooks");
    mkdirSync(hooksDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("getHookSettings returns empty object when no schema and no config", () => {
    const manifest: HookManifest = {
      name: "test",
      description: "Test",
      version: "1.0.0",
      events: ["on-error"],
      script: "run.sh",
    };

    const settings = getHookSettings("test", manifest);
    expect(settings).toEqual({});
  });

  test("getHookSettings returns defaults from manifest schema", () => {
    const manifest: HookManifest = {
      name: "test",
      description: "Test",
      version: "1.0.0",
      events: ["on-error"],
      script: "run.sh",
      settingsSchema: {
        maxLen: { type: "number", default: 2000, description: "Max length" },
        verbose: { type: "boolean", default: false },
      },
    };

    const settings = getHookSettings("test", manifest);
    expect(settings.maxLen).toBe(2000);
    expect(settings.verbose).toBe(false);
  });

  test("getHookSettings merges user overrides over defaults", () => {
    const manifest: HookManifest = {
      name: "test",
      description: "Test",
      version: "1.0.0",
      events: ["on-error"],
      script: "run.sh",
      settingsSchema: {
        maxLen: { type: "number", default: 2000 },
        verbose: { type: "boolean", default: false },
      },
    };

    saveHooksConfig({
      version: 1,
      hooks: {
        test: {
          enabled: true,
          settings: { maxLen: 5000 },
        },
      },
    });

    const settings = getHookSettings("test", manifest);
    expect(settings.maxLen).toBe(5000); // Overridden
    expect(settings.verbose).toBe(false); // Default preserved
  });

  test("getHookSettings allows user settings without schema", () => {
    const manifest: HookManifest = {
      name: "test",
      description: "Test",
      version: "1.0.0",
      events: ["on-error"],
      script: "run.sh",
    };

    saveHooksConfig({
      version: 1,
      hooks: {
        test: {
          enabled: true,
          settings: { customKey: "customValue" },
        },
      },
    });

    const settings = getHookSettings("test", manifest);
    expect(settings.customKey).toBe("customValue");
  });

  test("VELLUM_HOOK_SETTINGS env var is passed to script", async () => {
    const hookDir = join(hooksDir, "settings-hook");
    mkdirSync(hookDir, { recursive: true });

    const manifest: HookManifest = {
      name: "settings-hook",
      description: "Settings test",
      version: "1.0.0",
      events: ["on-error"],
      script: "run.sh",
      settingsSchema: {
        greeting: { type: "string", default: "hello" },
      },
    };
    writeFileSync(join(hookDir, "hook.json"), JSON.stringify(manifest));

    const outputFile = join(testDir, "settings-output.txt");
    const scriptContent = `#!/bin/bash\necho "$VELLUM_HOOK_SETTINGS" > "${outputFile}"`;
    writeFileSync(join(hookDir, "run.sh"), scriptContent);
    chmodSync(join(hookDir, "run.sh"), 0o755);

    saveHooksConfig({
      version: 1,
      hooks: {
        "settings-hook": {
          enabled: true,
          settings: { greeting: "world" },
        },
      },
    });

    const hook: DiscoveredHook = {
      name: "settings-hook",
      dir: hookDir,
      manifest,
      scriptPath: join(hookDir, "run.sh"),
      enabled: true,
    };

    await runHookScript(hook, { event: "on-error" });

    await new Promise((r) => setTimeout(r, 200));
    const output = JSON.parse(readFileSync(outputFile, "utf-8").trim());
    expect(output.greeting).toBe("world"); // User override
  });
});

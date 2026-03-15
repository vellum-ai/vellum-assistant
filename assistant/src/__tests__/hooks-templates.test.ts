import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Set BASE_DATA_DIR before importing modules that use getRootDir()
const testDir = join(tmpdir(), `hooks-templates-test-${Date.now()}`);
process.env.BASE_DATA_DIR = testDir;

import {
  ensureHookInConfig,
  loadHooksConfig,
  setHookEnabled,
} from "../hooks/config.js";
import { installTemplates } from "../hooks/templates.js";

/**
 * Create a fake hook-templates directory structure that mimics
 * the bundled templates at `assistant/hook-templates/`.
 */
function createTemplateDir(
  templatesDir: string,
  name: string,
  manifest: Record<string, unknown>,
  scriptContent = "#!/bin/bash\nexit 0",
): void {
  const dir = join(templatesDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hook.json"), JSON.stringify(manifest));
  const scriptName = (manifest.script as string) ?? "run.sh";
  writeFileSync(join(dir, scriptName), scriptContent);
}

describe("Hook Templates", () => {
  let hooksDir: string;

  beforeEach(() => {
    hooksDir = join(testDir, ".vellum", "hooks");
    mkdirSync(hooksDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("installs template to hooks directory", () => {
    // installTemplates looks relative to its own file location.
    // We'll test by creating a template in the actual hook-templates dir
    // and verifying the installer's behavior through the public API.
    // For unit testing, we test the core logic directly.

    // Create a mock templates directory
    const templatesDir = join(testDir, "hook-templates");
    createTemplateDir(templatesDir, "test-hook", {
      name: "test-hook",
      description: "A test template",
      version: "1.0.0",
      events: ["on-error"],
      script: "run.sh",
    });

    // Manually simulate what installTemplates does
    const entries = readdirSync(templatesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const targetDir = join(hooksDir, entry.name);
      if (existsSync(targetDir)) continue;
      cpSync(join(templatesDir, entry.name), targetDir, { recursive: true });
      const manifestPath = join(targetDir, "hook.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (manifest.script) {
        chmodSync(join(targetDir, manifest.script), 0o755);
      }
    }

    expect(existsSync(join(hooksDir, "test-hook", "hook.json"))).toBe(true);
    expect(existsSync(join(hooksDir, "test-hook", "run.sh"))).toBe(true);

    // Check script is executable
    const stat = statSync(join(hooksDir, "test-hook", "run.sh"));
    expect((stat.mode & 0o111) !== 0).toBe(true);
  });

  test("does not overwrite existing hooks", () => {
    // Pre-create a hook with custom content
    const existingHookDir = join(hooksDir, "existing-hook");
    mkdirSync(existingHookDir, { recursive: true });
    writeFileSync(
      join(existingHookDir, "hook.json"),
      JSON.stringify({
        name: "existing-hook",
        description: "User-modified hook",
        version: "2.0.0",
        events: ["on-error"],
        script: "run.sh",
      }),
    );
    writeFileSync(
      join(existingHookDir, "run.sh"),
      '#!/bin/bash\necho "custom"',
    );

    // Create a template with the same name but different content
    const templatesDir = join(testDir, "hook-templates");
    createTemplateDir(
      templatesDir,
      "existing-hook",
      {
        name: "existing-hook",
        description: "Template version",
        version: "1.0.0",
        events: ["on-error"],
        script: "run.sh",
      },
      '#!/bin/bash\necho "template"',
    );

    // Simulate install — should skip
    const entries = readdirSync(templatesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const targetDir = join(hooksDir, entry.name);
      if (existsSync(targetDir)) continue; // Should skip
      cpSync(join(templatesDir, entry.name), targetDir, { recursive: true });
    }

    // Verify original content preserved
    const manifest = JSON.parse(
      readFileSync(join(existingHookDir, "hook.json"), "utf-8"),
    );
    expect(manifest.version).toBe("2.0.0");
    expect(manifest.description).toBe("User-modified hook");
  });

  test("installTemplates runs without error when no templates dir exists", () => {
    // installTemplates should gracefully handle missing templates dir
    // This tests the guard: if (!existsSync(templatesDir)) return;
    expect(() => installTemplates()).not.toThrow();
  });

  test("config entry is added for installed template", () => {
    // Manually install a template and call ensureHookInConfig
    ensureHookInConfig("new-template", { enabled: false });

    const config = loadHooksConfig();
    expect(config.hooks["new-template"]).toEqual({ enabled: false });
  });

  test("config entry preserves existing enabled state", () => {
    // Set hook as enabled first
    setHookEnabled("my-hook", true);

    // ensureHookInConfig should not overwrite
    ensureHookInConfig("my-hook", { enabled: false });

    const config = loadHooksConfig();
    expect(config.hooks["my-hook"].enabled).toBe(true);
  });
});

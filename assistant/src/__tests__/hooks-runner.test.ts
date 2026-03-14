import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Set BASE_DATA_DIR before importing modules that use getRootDir()
const testDir = join(tmpdir(), `hooks-runner-test-${Date.now()}`);
process.env.BASE_DATA_DIR = testDir;

import { runHookScript } from "../hooks/runner.js";
import type { DiscoveredHook, HookEventData } from "../hooks/types.js";

function createTestHook(
  hooksDir: string,
  name: string,
  scriptContent: string,
): DiscoveredHook {
  const hookDir = join(hooksDir, name);
  mkdirSync(hookDir, { recursive: true });
  const scriptPath = join(hookDir, "run.sh");
  writeFileSync(scriptPath, scriptContent);
  chmodSync(scriptPath, 0o755);

  return {
    name,
    dir: hookDir,
    manifest: {
      name,
      description: "Test hook",
      version: "1.0.0",
      events: ["pre-tool-execute"],
      script: "run.sh",
    },
    scriptPath,
    enabled: true,
  };
}

describe("Hook Runner", () => {
  let hooksDir: string;

  beforeEach(() => {
    hooksDir = join(testDir, ".vellum", "workspace", "hooks");
    mkdirSync(hooksDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("runs a script and captures stdout", async () => {
    const hook = createTestHook(
      hooksDir,
      "echo-hook",
      '#!/bin/bash\necho "hello from hook"',
    );
    const eventData: HookEventData = { event: "pre-tool-execute" };

    const result = await runHookScript(hook, eventData);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello from hook");
    expect(result.stderr).toBe("");
  });

  test("captures stderr", async () => {
    const hook = createTestHook(
      hooksDir,
      "stderr-hook",
      '#!/bin/bash\necho "error output" >&2',
    );
    const eventData: HookEventData = { event: "on-error" };

    const result = await runHookScript(hook, eventData);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.trim()).toBe("error output");
  });

  test("reports non-zero exit code", async () => {
    const hook = createTestHook(hooksDir, "fail-hook", "#!/bin/bash\nexit 42");
    const eventData: HookEventData = { event: "on-error" };

    const result = await runHookScript(hook, eventData);
    expect(result.exitCode).toBe(42);
  });

  test("pipes event data to stdin as JSON", async () => {
    const hook = createTestHook(hooksDir, "stdin-hook", "#!/bin/bash\ncat");
    const eventData: HookEventData = {
      event: "pre-tool-execute",
      tool: "Bash",
      command: "ls",
    };

    const result = await runHookScript(hook, eventData);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.event).toBe("pre-tool-execute");
    expect(parsed.tool).toBe("Bash");
    expect(parsed.command).toBe("ls");
  });

  test("sets environment variables", async () => {
    const hook = createTestHook(
      hooksDir,
      "env-hook",
      '#!/bin/bash\necho "$VELLUM_HOOK_EVENT|$VELLUM_HOOK_NAME"',
    );
    const eventData: HookEventData = { event: "post-message" };

    const result = await runHookScript(hook, eventData);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("post-message|env-hook");
  });

  test("sets VELLUM_ROOT_DIR environment variable", async () => {
    const hook = createTestHook(
      hooksDir,
      "rootdir-hook",
      '#!/bin/bash\necho "$VELLUM_ROOT_DIR"',
    );
    const eventData: HookEventData = { event: "daemon-start" };

    const result = await runHookScript(hook, eventData);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain(".vellum");
  });

  test("sets VELLUM_WORKSPACE_DIR environment variable", async () => {
    const hook = createTestHook(
      hooksDir,
      "wsdir-hook",
      '#!/bin/bash\necho "$VELLUM_WORKSPACE_DIR"',
    );
    const eventData: HookEventData = { event: "daemon-start" };

    const result = await runHookScript(hook, eventData);
    expect(result.exitCode).toBe(0);
    const wsDir = result.stdout.trim();
    expect(wsDir).toContain(".vellum");
    expect(wsDir).toEndWith("workspace");
  });

  test("sets both VELLUM_ROOT_DIR and VELLUM_WORKSPACE_DIR", async () => {
    const hook = createTestHook(
      hooksDir,
      "both-dirs-hook",
      '#!/bin/bash\necho "$VELLUM_ROOT_DIR|$VELLUM_WORKSPACE_DIR"',
    );
    const eventData: HookEventData = { event: "pre-tool-execute" };

    const result = await runHookScript(hook, eventData);
    expect(result.exitCode).toBe(0);
    const [rootDir, wsDir] = result.stdout.trim().split("|");
    expect(rootDir).toContain(".vellum");
    expect(wsDir).toContain(".vellum");
    expect(wsDir).toEndWith("workspace");
    // workspace dir should be a subdirectory of root dir
    expect(wsDir).toStartWith(rootDir);
  });

  test("handles non-existent script gracefully", async () => {
    const hook: DiscoveredHook = {
      name: "missing-script",
      dir: join(hooksDir, "missing-script"),
      manifest: {
        name: "missing-script",
        description: "Missing",
        version: "1.0.0",
        events: ["on-error"],
        script: "nonexistent.sh",
      },
      scriptPath: join(hooksDir, "missing-script", "nonexistent.sh"),
      enabled: true,
    };
    mkdirSync(hook.dir, { recursive: true });
    const eventData: HookEventData = { event: "on-error" };

    const result = await runHookScript(hook, eventData);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toBeTruthy();
  });

  test("runs script in hook directory as cwd", async () => {
    const hook = createTestHook(hooksDir, "cwd-hook", "#!/bin/bash\npwd -P");
    const eventData: HookEventData = { event: "pre-tool-execute" };

    const result = await runHookScript(hook, eventData);
    expect(result.exitCode).toBe(0);
    // Use realpathSync to resolve macOS /var -> /private/var symlinks
    const { realpathSync } = await import("node:fs");
    expect(result.stdout.trim()).toBe(realpathSync(hook.dir));
  });
});

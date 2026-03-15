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
const testDir = join(tmpdir(), `hooks-integration-test-${Date.now()}`);
process.env.BASE_DATA_DIR = testDir;

import { saveHooksConfig } from "../hooks/config.js";
import { HookManager, resetHookManager } from "../hooks/manager.js";

function createHook(
  hooksDir: string,
  name: string,
  events: string[],
  scriptContent: string,
): void {
  const hookDir = join(hooksDir, name);
  mkdirSync(hookDir, { recursive: true });
  writeFileSync(
    join(hookDir, "hook.json"),
    JSON.stringify({
      name,
      description: `Integration test hook: ${name}`,
      version: "1.0.0",
      events,
      script: "run.sh",
    }),
  );
  const scriptPath = join(hookDir, "run.sh");
  writeFileSync(scriptPath, scriptContent);
  chmodSync(scriptPath, 0o755);
}

describe("Hooks Integration", () => {
  let hooksDir: string;

  beforeEach(() => {
    hooksDir = join(testDir, ".vellum", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    resetHookManager();
  });

  afterEach(() => {
    resetHookManager();
    rmSync(testDir, { recursive: true, force: true });
  });

  test("hook receives event data via stdin", async () => {
    const outputFile = join(testDir, "stdin-data.json");
    createHook(
      hooksDir,
      "stdin-capture",
      ["pre-tool-execute"],
      `#!/bin/bash\ncat > "${outputFile}"`,
    );
    saveHooksConfig({
      version: 1,
      hooks: { "stdin-capture": { enabled: true } },
    });

    const manager = new HookManager();
    manager.initialize();

    await manager.trigger("pre-tool-execute", {
      toolName: "bash",
      command: "ls -la",
      riskLevel: "medium",
    });

    // Wait for file write to complete
    await new Promise((r) => setTimeout(r, 200));
    const data = JSON.parse(readFileSync(outputFile, "utf-8"));
    expect(data.event).toBe("pre-tool-execute");
    expect(data.toolName).toBe("bash");
    expect(data.command).toBe("ls -la");
  });

  test("hook receives environment variables", async () => {
    const outputFile = join(testDir, "env-data.txt");
    createHook(
      hooksDir,
      "env-capture",
      ["daemon-start"],
      `#!/bin/bash\necho "$VELLUM_HOOK_EVENT|$VELLUM_HOOK_NAME|$VELLUM_ROOT_DIR" > "${outputFile}"`,
    );
    saveHooksConfig({
      version: 1,
      hooks: { "env-capture": { enabled: true } },
    });

    const manager = new HookManager();
    manager.initialize();

    await manager.trigger("daemon-start", { pid: 12345 });

    await new Promise((r) => setTimeout(r, 200));
    const output = readFileSync(outputFile, "utf-8").trim();
    const parts = output.split("|");
    expect(parts[0]).toBe("daemon-start");
    expect(parts[1]).toBe("env-capture");
    expect(parts[2]).toContain(".vellum");
  });

  test("multiple hooks for same event run in order", async () => {
    const outputFile = join(testDir, "order.txt");
    createHook(
      hooksDir,
      "hook-c",
      ["on-error"],
      `#!/bin/bash\necho "c" >> "${outputFile}"`,
    );
    createHook(
      hooksDir,
      "hook-a",
      ["on-error"],
      `#!/bin/bash\necho "a" >> "${outputFile}"`,
    );
    createHook(
      hooksDir,
      "hook-b",
      ["on-error"],
      `#!/bin/bash\necho "b" >> "${outputFile}"`,
    );
    saveHooksConfig({
      version: 1,
      hooks: {
        "hook-a": { enabled: true },
        "hook-b": { enabled: true },
        "hook-c": { enabled: true },
      },
    });

    const manager = new HookManager();
    manager.initialize();

    await manager.trigger("on-error", { message: "test error" });

    await new Promise((r) => setTimeout(r, 200));
    const lines = readFileSync(outputFile, "utf-8").trim().split("\n");
    expect(lines).toEqual(["a", "b", "c"]);
  });

  test("hook failure does not prevent subsequent hooks", async () => {
    const outputFile = join(testDir, "after-failure.txt");
    createHook(hooksDir, "hook-fail", ["post-message"], "#!/bin/bash\nexit 1");
    createHook(
      hooksDir,
      "hook-success",
      ["post-message"],
      `#!/bin/bash\necho "ran" > "${outputFile}"`,
    );
    saveHooksConfig({
      version: 1,
      hooks: {
        "hook-fail": { enabled: true },
        "hook-success": { enabled: true },
      },
    });

    const manager = new HookManager();
    manager.initialize();

    await manager.trigger("post-message", {});

    await new Promise((r) => setTimeout(r, 200));
    const output = readFileSync(outputFile, "utf-8").trim();
    expect(output).toBe("ran");
  });

  test("disabled hooks are not triggered", async () => {
    const outputFile = join(testDir, "disabled.txt");
    createHook(
      hooksDir,
      "disabled-hook",
      ["pre-message"],
      `#!/bin/bash\necho "should not run" > "${outputFile}"`,
    );
    // Not enabled in config (defaults to disabled)

    const manager = new HookManager();
    manager.initialize();

    await manager.trigger("pre-message", {});

    await new Promise((r) => setTimeout(r, 200));
    expect(() => readFileSync(outputFile, "utf-8")).toThrow();
  });
});

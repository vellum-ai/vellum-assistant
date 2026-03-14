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
const testDir = join(tmpdir(), `hooks-blocking-test-${Date.now()}`);
process.env.BASE_DATA_DIR = testDir;

import { saveHooksConfig } from "../hooks/config.js";
import { HookManager, resetHookManager } from "../hooks/manager.js";

function createHook(
  hooksDir: string,
  name: string,
  events: string[],
  scriptContent: string,
  blocking = false,
): void {
  const hookDir = join(hooksDir, name);
  mkdirSync(hookDir, { recursive: true });
  writeFileSync(
    join(hookDir, "hook.json"),
    JSON.stringify({
      name,
      description: `Test hook ${name}`,
      version: "1.0.0",
      events,
      script: "run.sh",
      ...(blocking ? { blocking: true } : {}),
    }),
  );
  const scriptPath = join(hookDir, "run.sh");
  writeFileSync(scriptPath, scriptContent);
  chmodSync(scriptPath, 0o755);
}

describe("Blocking Hooks", () => {
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

  test("blocking hook on pre-* event cancels action on non-zero exit", async () => {
    createHook(
      hooksDir,
      "guard",
      ["pre-tool-execute"],
      "#!/bin/bash\nexit 1",
      true,
    );
    saveHooksConfig({ version: 1, hooks: { guard: { enabled: true } } });

    const manager = new HookManager();
    manager.initialize();

    const result = await manager.trigger("pre-tool-execute", {
      toolName: "bash",
    });
    expect(result.blocked).toBe(true);
    expect(result.blockedBy).toBe("guard");
  });

  test("blocking hook on pre-* event allows action on zero exit", async () => {
    createHook(
      hooksDir,
      "pass-guard",
      ["pre-tool-execute"],
      "#!/bin/bash\nexit 0",
      true,
    );
    saveHooksConfig({ version: 1, hooks: { "pass-guard": { enabled: true } } });

    const manager = new HookManager();
    manager.initialize();

    const result = await manager.trigger("pre-tool-execute", {
      toolName: "bash",
    });
    expect(result.blocked).toBe(false);
  });

  test("non-blocking hook does not cancel even on non-zero exit", async () => {
    createHook(
      hooksDir,
      "logger",
      ["pre-tool-execute"],
      "#!/bin/bash\nexit 1",
      false,
    );
    saveHooksConfig({ version: 1, hooks: { logger: { enabled: true } } });

    const manager = new HookManager();
    manager.initialize();

    const result = await manager.trigger("pre-tool-execute", {
      toolName: "bash",
    });
    expect(result.blocked).toBe(false);
  });

  test("blocking hook on non-pre event does not cancel", async () => {
    createHook(
      hooksDir,
      "post-guard",
      ["post-tool-execute"],
      "#!/bin/bash\nexit 1",
      true,
    );
    saveHooksConfig({ version: 1, hooks: { "post-guard": { enabled: true } } });

    const manager = new HookManager();
    manager.initialize();

    const result = await manager.trigger("post-tool-execute", {
      toolName: "bash",
    });
    expect(result.blocked).toBe(false);
  });

  test("blocking hook stops subsequent hooks from running", async () => {
    const outputFile = join(testDir, "after-block.txt");
    createHook(
      hooksDir,
      "blocker",
      ["pre-llm-call"],
      "#!/bin/bash\nexit 1",
      true,
    );
    createHook(
      hooksDir,
      "logger",
      ["pre-llm-call"],
      `#!/bin/bash\necho "ran" > "${outputFile}"`,
      false,
    );
    saveHooksConfig({
      version: 1,
      hooks: {
        blocker: { enabled: true },
        logger: { enabled: true },
      },
    });

    const manager = new HookManager();
    manager.initialize();

    const result = await manager.trigger("pre-llm-call", {});
    expect(result.blocked).toBe(true);
    expect(result.blockedBy).toBe("blocker");

    // Logger should NOT have run because blocker runs first (alphabetical order)
    await new Promise((r) => setTimeout(r, 100));
    expect(() => readFileSync(outputFile, "utf-8")).toThrow();
  });

  test("trigger returns not blocked when no hooks match", async () => {
    const manager = new HookManager();
    manager.initialize();

    const result = await manager.trigger("pre-tool-execute", {});
    expect(result.blocked).toBe(false);
  });
});

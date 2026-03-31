import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Set VELLUM_WORKSPACE_DIR before importing modules that use getWorkspaceDir()
const testDir = join(tmpdir(), `hooks-manager-test-${Date.now()}`);
process.env.VELLUM_WORKSPACE_DIR = testDir;

import { saveHooksConfig } from "../hooks/config.js";
import {
  getHookManager,
  HookManager,
  resetHookManager,
} from "../hooks/manager.js";

function createHook(
  hooksDir: string,
  name: string,
  events: string[],
  scriptContent = "#!/bin/bash\nexit 0",
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
    }),
  );
  const scriptPath = join(hookDir, "run.sh");
  writeFileSync(scriptPath, scriptContent);
  chmodSync(scriptPath, 0o755);
}

describe("HookManager", () => {
  let hooksDir: string;

  beforeEach(() => {
    hooksDir = join(testDir, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    resetHookManager();
  });

  afterEach(() => {
    resetHookManager();
    rmSync(testDir, { recursive: true, force: true });
  });

  test("initialize discovers hooks", () => {
    createHook(hooksDir, "test-hook", ["on-error"]);
    saveHooksConfig({ version: 1, hooks: { "test-hook": { enabled: true } } });

    const manager = new HookManager();
    manager.initialize();
    expect(manager.getDiscoveredHooks()).toHaveLength(1);
    expect(manager.getDiscoveredHooks()[0].name).toBe("test-hook");
  });

  test("initialize returns empty when no hooks", () => {
    const manager = new HookManager();
    manager.initialize();
    expect(manager.getDiscoveredHooks()).toHaveLength(0);
  });

  test("trigger does nothing for event with no hooks", async () => {
    const manager = new HookManager();
    manager.initialize();
    // Should not throw
    await manager.trigger("on-error", {});
  });

  test("trigger runs enabled hooks for matching event", async () => {
    createHook(
      hooksDir,
      "log-hook",
      ["pre-tool-execute"],
      '#!/bin/bash\necho "executed"',
    );
    saveHooksConfig({ version: 1, hooks: { "log-hook": { enabled: true } } });

    const manager = new HookManager();
    manager.initialize();
    await manager.trigger("pre-tool-execute", { tool: "Bash" });
  });

  test("trigger skips disabled hooks", async () => {
    createHook(
      hooksDir,
      "disabled-hook",
      ["on-error"],
      '#!/bin/bash\necho "should not run"',
    );
    // Not enabled in config (defaults to disabled)

    const manager = new HookManager();
    manager.initialize();
    await manager.trigger("on-error", {});
  });

  test("trigger only runs hooks subscribed to the event", async () => {
    createHook(
      hooksDir,
      "tool-hook",
      ["pre-tool-execute"],
      '#!/bin/bash\necho "tool"',
    );
    createHook(
      hooksDir,
      "error-hook",
      ["on-error"],
      '#!/bin/bash\necho "error"',
    );
    saveHooksConfig({
      version: 1,
      hooks: {
        "tool-hook": { enabled: true },
        "error-hook": { enabled: true },
      },
    });

    const manager = new HookManager();
    manager.initialize();
    await manager.trigger("pre-tool-execute", {});
  });

  test("trigger runs hooks sequentially in alphabetical order", async () => {
    // Create hooks that append to a shared file to verify execution order
    const orderFile = join(testDir, "order.txt");
    createHook(
      hooksDir,
      "zebra",
      ["post-message"],
      `#!/bin/bash\necho "zebra" >> "${orderFile}"`,
    );
    createHook(
      hooksDir,
      "alpha",
      ["post-message"],
      `#!/bin/bash\necho "alpha" >> "${orderFile}"`,
    );
    createHook(
      hooksDir,
      "middle",
      ["post-message"],
      `#!/bin/bash\necho "middle" >> "${orderFile}"`,
    );
    saveHooksConfig({
      version: 1,
      hooks: {
        zebra: { enabled: true },
        alpha: { enabled: true },
        middle: { enabled: true },
      },
    });

    const manager = new HookManager();
    manager.initialize();
    await manager.trigger("post-message", {});

    await new Promise((r) => setTimeout(r, 100));
    const { readFileSync } = await import("node:fs");
    const order = readFileSync(orderFile, "utf-8").trim().split("\n");
    expect(order).toEqual(["alpha", "middle", "zebra"]);
  });

  test("trigger handles hook failure gracefully", async () => {
    createHook(hooksDir, "bad-hook", ["on-error"], "#!/bin/bash\nexit 1");
    saveHooksConfig({ version: 1, hooks: { "bad-hook": { enabled: true } } });

    const manager = new HookManager();
    manager.initialize();
    await manager.trigger("on-error", { message: "test error" });
  });

  test("getDiscoveredHooks returns a copy", () => {
    createHook(hooksDir, "hook-a", ["on-error"]);
    saveHooksConfig({ version: 1, hooks: { "hook-a": { enabled: true } } });

    const manager = new HookManager();
    manager.initialize();

    const hooks1 = manager.getDiscoveredHooks();
    const hooks2 = manager.getDiscoveredHooks();
    expect(hooks1).toEqual(hooks2);
    expect(hooks1).not.toBe(hooks2);
  });

  test("getHookManager returns singleton", () => {
    const mgr1 = getHookManager();
    const mgr2 = getHookManager();
    expect(mgr1).toBe(mgr2);
  });

  test("resetHookManager clears singleton", () => {
    const mgr1 = getHookManager();
    resetHookManager();
    const mgr2 = getHookManager();
    expect(mgr1).not.toBe(mgr2);
  });

  test("multi-event hook is triggered for each subscribed event", async () => {
    const outputFile = join(testDir, "multi-event.txt");
    createHook(
      hooksDir,
      "multi",
      ["pre-tool-execute", "on-error"],
      `#!/bin/bash\necho "$VELLUM_HOOK_EVENT" >> "${outputFile}"`,
    );
    saveHooksConfig({ version: 1, hooks: { multi: { enabled: true } } });

    const manager = new HookManager();
    manager.initialize();
    await manager.trigger("pre-tool-execute", {});
    await manager.trigger("on-error", {});

    await new Promise((r) => setTimeout(r, 100));
    const { readFileSync } = await import("node:fs");
    const events = readFileSync(outputFile, "utf-8").trim().split("\n");
    expect(events).toEqual(["pre-tool-execute", "on-error"]);
  });
});

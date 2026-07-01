/**
 * Tests for per-surface plugin disabled-state filtering.
 *
 * Verifies that `assistant plugins disable default-*` takes effect on the
 * next turn without a daemon restart. The `.disabled` sentinel is checked at
 * read time by each surface (`getHooksFor` for hooks,
 * `getPluginToolDefinitions` for tools, `getRegisteredInjectors` for runtime
 * injectors) rather than at boot, so toggling the sentinel file at runtime is
 * immediately reflected.
 */

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getHooksFor } from "../hooks/registry.js";
import { RiskLevel } from "../permissions/types.js";
import type { MessagePersistedEvent } from "../persistence/memory-lifecycle-hooks.js";
import { guardPersistenceHooksByDisabledState } from "../plugins/defaults/index.js";
import {
  clearInjectorRegistry,
  getRegisteredInjectors,
  registerPluginInjectors,
} from "../plugins/injector-registry.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
  unregisterPlugin,
} from "../plugins/registry.js";
import {
  type HookFunction,
  type Injector,
  type Plugin,
} from "../plugins/types.js";
import {
  getAllToolDefinitions,
  getPluginToolDefinitions,
  registerPluginTools,
} from "../tools/registry.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../tools/types.js";

const TEST_WORKSPACE_DIR = join(
  tmpdir(),
  `vellum-plugin-disabled-state-test-${process.pid}-${Date.now()}`,
);
process.env.VELLUM_WORKSPACE_DIR = TEST_WORKSPACE_DIR;

async function createSentinel(name: string): Promise<void> {
  const dir = join(TEST_WORKSPACE_DIR, "plugins", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".disabled"), "");
}

async function removeSentinel(name: string): Promise<void> {
  const dir = join(TEST_WORKSPACE_DIR, "plugins", name);
  await rm(dir, { recursive: true, force: true });
}

function buildPlugin(
  name: string,
  hooks: Record<string, HookFunction> = {},
): Plugin {
  return {
    manifest: { name, version: "1.0.0" },
    hooks,
  };
}

function makeFakeTool(name: string): Tool {
  return {
    name,
    description: `Fake ${name}`,
    defaultRiskLevel: RiskLevel.Low,
    executionTarget: "sandbox",
    input_schema: { type: "object", properties: {}, required: [] },
    category: "plugin",
    async execute(
      _input: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolExecutionResult> {
      return { content: "ok", isError: false };
    },
  };
}

beforeEach(() => {
  resetPluginRegistryForTests();
  clearInjectorRegistry();
});

afterEach(async () => {
  // Clean up any sentinel files created during the test.
  const pluginsDir = join(TEST_WORKSPACE_DIR, "plugins");
  if (existsSync(pluginsDir)) {
    await rm(pluginsDir, { recursive: true, force: true });
  }
});

describe("per-surface disabled-state filtering", () => {
  test("getHooksFor filters out hooks from a disabled plugin", async () => {
    const plugin = buildPlugin("default-test-hook", {
      "user-prompt-submit": () => Promise.resolve(),
    });
    registerPlugin(plugin);

    // Before disabling: hook is included.
    const hooksBefore = await getHooksFor("user-prompt-submit");
    expect(hooksBefore).toHaveLength(1);

    // Disable via sentinel.
    await createSentinel("default-test-hook");

    // After disabling: hook is filtered out at read time.
    const hooksAfter = await getHooksFor("user-prompt-submit");
    expect(hooksAfter).toHaveLength(0);

    // Clean up.
    await removeSentinel("default-test-hook");
  });

  test("getHooksFor re-includes hooks when a disabled plugin is re-enabled", async () => {
    const plugin = buildPlugin("default-test-reenable", {
      "user-prompt-submit": () => Promise.resolve(),
    });
    registerPlugin(plugin);

    // Disable.
    await createSentinel("default-test-reenable");
    let hooks = await getHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(0);

    // Re-enable by removing the sentinel.
    await removeSentinel("default-test-reenable");
    hooks = await getHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(1);
  });

  test("getPluginToolDefinitions filters out tools from a disabled plugin", async () => {
    const plugin: Plugin = {
      manifest: { name: "default-test-tools", version: "1.0.0" },
      tools: [makeFakeTool("test_tool")],
    };
    registerPlugin(plugin);
    registerPluginTools("default-test-tools", plugin.tools!);

    // Before disabling: tool is visible.
    let defs = getPluginToolDefinitions();
    expect(defs.some((d) => d.name === "test_tool")).toBe(true);

    // Disable via sentinel.
    await createSentinel("default-test-tools");

    // After disabling: tool is filtered out.
    defs = getPluginToolDefinitions();
    expect(defs.some((d) => d.name === "test_tool")).toBe(false);

    // Re-enable.
    await removeSentinel("default-test-tools");
    defs = getPluginToolDefinitions();
    expect(defs.some((d) => d.name === "test_tool")).toBe(true);
  });

  test("getAllToolDefinitions excludes tools from a disabled plugin", async () => {
    // getAllToolDefinitions is the base tool snapshot the conversation tool
    // resolver captures at creation. A plugin disabled BEFORE a new
    // conversation starts must not leak its tools here — otherwise the
    // resolver's core/plugin split (which reads the filtered
    // getPluginToolDefinitions) misclassifies them as core and keeps them on
    // the wire to the LLM, executable despite being hidden from the catalog.
    const plugin: Plugin = {
      manifest: { name: "default-test-base-snapshot", version: "1.0.0" },
      tools: [makeFakeTool("base_snapshot_tool")],
    };
    registerPlugin(plugin);
    registerPluginTools("default-test-base-snapshot", plugin.tools!);

    // Before disabling: tool is part of the base snapshot.
    let defs = getAllToolDefinitions();
    expect(defs.some((d) => d.name === "base_snapshot_tool")).toBe(true);

    // Disable via sentinel.
    await createSentinel("default-test-base-snapshot");

    // After disabling: tool drops from the base snapshot at read time.
    defs = getAllToolDefinitions();
    expect(defs.some((d) => d.name === "base_snapshot_tool")).toBe(false);

    // Re-enable.
    await removeSentinel("default-test-base-snapshot");
    defs = getAllToolDefinitions();
    expect(defs.some((d) => d.name === "base_snapshot_tool")).toBe(true);
  });

  test("getRegisteredInjectors filters out injectors from a disabled plugin", async () => {
    const injector: Injector = {
      name: "test_injector",
      order: 5,
      produce: () => Promise.resolve(null),
    };
    registerPluginInjectors("default-test-injectors", [injector]);

    // Before disabling: injector is in the chain.
    expect(
      getRegisteredInjectors().some((i) => i.name === "test_injector"),
    ).toBe(true);

    // Disable via sentinel — filtered at read time, no restart needed.
    await createSentinel("default-test-injectors");
    expect(
      getRegisteredInjectors().some((i) => i.name === "test_injector"),
    ).toBe(false);

    // Re-enable.
    await removeSentinel("default-test-injectors");
    expect(
      getRegisteredInjectors().some((i) => i.name === "test_injector"),
    ).toBe(true);
  });

  test("disabling one plugin does not affect others", async () => {
    const pluginA = buildPlugin("default-test-alpha", {
      "user-prompt-submit": () => Promise.resolve(),
    });
    const pluginB = buildPlugin("default-test-beta", {
      "user-prompt-submit": () => Promise.resolve(),
    });
    registerPlugin(pluginA);
    registerPlugin(pluginB);

    // Both visible.
    let hooks = await getHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(2);

    // Disable only alpha.
    await createSentinel("default-test-alpha");
    hooks = await getHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(1);

    // Re-enable alpha.
    await removeSentinel("default-test-alpha");
    hooks = await getHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(2);
  });

  test("unregisterPlugin removes hooks from the hook registry", async () => {
    const plugin = buildPlugin("default-test-unreg", {
      "user-prompt-submit": () => Promise.resolve(),
    });
    registerPlugin(plugin);

    let hooks = await getHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(1);

    unregisterPlugin("default-test-unreg");

    hooks = await getHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(0);
  });

  test("persistence hooks no-op while the memory plugin is disabled", async () => {
    let calls = 0;
    const guarded = guardPersistenceHooksByDisabledState("default-memory", {
      onMessagePersisted() {
        calls++;
      },
      onConversationForked() {},
      onConversationWiped() {
        return 0;
      },
      onConversationDeleted() {},
      onMessagesDeleted() {},
      async onAllConversationsCleared() {},
      onWorkerStartup() {},
    });
    const event: MessagePersistedEvent = {
      messageId: "msg-1",
      conversationId: "conv-1",
      role: "user",
      content: "[]",
      createdAt: 0,
    };

    // Enabled: the wrapped handler runs.
    await guarded.onMessagePersisted(event);
    expect(calls).toBe(1);

    // Disable via sentinel — checked at call time, no restart needed.
    await createSentinel("default-memory");
    await guarded.onMessagePersisted(event);
    expect(calls).toBe(1);

    // Re-enable.
    await removeSentinel("default-memory");
    await guarded.onMessagePersisted(event);
    expect(calls).toBe(2);
  });

  test("cleanup persistence hooks run even while the memory plugin is disabled", async () => {
    let wiped = 0;
    let swept = 0;
    const deleted: string[][] = [];
    const convDeleted: string[] = [];
    let cleared = 0;
    const guarded = guardPersistenceHooksByDisabledState("default-memory", {
      onMessagePersisted() {},
      onConversationForked() {},
      onConversationWiped() {
        wiped++;
        return 7;
      },
      onConversationDeleted(id) {
        convDeleted.push(id);
      },
      onMessagesDeleted(ids) {
        deleted.push(ids);
      },
      async onAllConversationsCleared() {
        cleared++;
      },
      onWorkerStartup() {
        swept++;
      },
    });

    await createSentinel("default-memory");

    // Cleanup hooks are NOT gated: they must still run (and return real values)
    // while disabled, or state created while enabled would be orphaned.
    expect(guarded.onConversationWiped("conv-1")).toBe(7);
    guarded.onConversationDeleted("conv-9");
    guarded.onMessagesDeleted(["msg-1", "msg-2"]);
    await guarded.onAllConversationsCleared();
    guarded.onWorkerStartup();
    expect(wiped).toBe(1);
    expect(convDeleted).toEqual(["conv-9"]);
    expect(deleted).toEqual([["msg-1", "msg-2"]]);
    expect(cleared).toBe(1);
    expect(swept).toBe(1);

    await removeSentinel("default-memory");
  });
});

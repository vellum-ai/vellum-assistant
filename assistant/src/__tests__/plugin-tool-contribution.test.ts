/**
 * Tests for plugin tool contributions (PR 31).
 *
 * Covers the end-to-end flow that lets a plugin declare tools on its
 * manifest and have them surface through the global tool registry:
 *
 * - Registering a plugin with `tools: Tool[]`, running `bootstrapPlugins`,
 *   and observing the contributed tool via `getAllTools()` / `getTool()`.
 * - Tool ownership metadata (`origin: "skill"`, `ownerSkillId: <plugin>`)
 *   stamped authoritatively by `registerPluginTools` regardless of what the
 *   plugin author set on the incoming object.
 * - Shutdown hook unregistering the contributed tools so the registry is
 *   clean again after teardown.
 * - Thin-wrapper semantics of `registerPluginTools` /
 *   `unregisterPluginTools` over `registerSkillTools` /
 *   `unregisterSkillTools`, including ref-counting.
 *
 * Uses `mock.module` to stub the credential store so bootstrap doesn't hit
 * the real backend. `resetPluginRegistryForTests()` and
 * `__clearRegistryForTesting()` isolate registry state between cases so
 * this file can run alongside other plugin/tool-registry tests without
 * cross-contamination.
 */

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the credential store before importing the bootstrap so the module
// under test captures the stubbed binding. Bootstrap only calls this for
// plugins that declare `requiresCredential`; the tests in this file don't,
// so the stub simply returns undefined.
const getSecureKeyAsyncMock = mock(
  async (_account: string): Promise<string | undefined> => undefined,
);
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: getSecureKeyAsyncMock,
}));

import type { AssistantConfig } from "../config/schema.js";
import {
  bootstrapPlugins,
  type DaemonContext,
} from "../daemon/external-plugins-bootstrap.js";
import { runShutdownHooks } from "../daemon/shutdown-registry.js";
import { RiskLevel } from "../permissions/types.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { Plugin } from "../plugins/types.js";
import type { ToolDefinition } from "../providers/types.js";
import {
  __clearRegistryForTesting,
  __resetRegistryForTesting,
  getAllTools,
  getSkillRefCount,
  getTool,
  registerPluginTools,
  unregisterPluginTools,
} from "../tools/registry.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../tools/types.js";

// Redirect plugin-storage-directory creation into a per-process temp tree so
// the test doesn't touch the developer's real ~/.vellum. This matches the
// convention used by plugin-bootstrap.test.ts.
const TEST_INSTANCE_DIR = join(
  tmpdir(),
  `vellum-plugin-tool-contrib-test-${process.pid}`,
);
process.env.BASE_DATA_DIR = TEST_INSTANCE_DIR;

const fakeConfig = {} as unknown as AssistantConfig;
const fakeCtx: DaemonContext = {
  config: fakeConfig,
  assistantVersion: "9.9.9-test",
};

function makeFakeTool(name: string, extras: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `Fake ${name}`,
    category: "plugin-test",
    defaultRiskLevel: RiskLevel.Low,
    getDefinition(): ToolDefinition {
      return {
        name,
        description: `Fake ${name}`,
        input_schema: { type: "object", properties: {}, required: [] },
      };
    },
    async execute(
      _input: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolExecutionResult> {
      return { content: "ok", isError: false };
    },
    ...extras,
  };
}

function buildPlugin(
  name: string,
  extras: Partial<Omit<Plugin, "manifest">> = {},
): Plugin {
  return {
    manifest: {
      name,
      version: "0.0.1",
      requires: { pluginRuntime: "v1" },
    },
    ...extras,
  };
}

describe("plugin tool contributions", () => {
  beforeEach(async () => {
    resetPluginRegistryForTests();
    // Clear the tool registry completely so we can make vacuous-free
    // assertions about which tools are present. We don't need any of the
    // eager/host tools for these tests.
    __clearRegistryForTesting();
    getSecureKeyAsyncMock.mockReset();
    getSecureKeyAsyncMock.mockImplementation(async () => undefined);
    await rm(TEST_INSTANCE_DIR, { recursive: true, force: true });
  });

  test("bootstrap registers plugin tools and makes them discoverable", async () => {
    const tool = makeFakeTool("plugin-contrib-tool");
    const plugin = buildPlugin("alpha-contributor", {
      async init() {},
      tools: [tool],
    });
    registerPlugin(plugin);

    await bootstrapPlugins(fakeCtx);

    const retrieved = getTool("plugin-contrib-tool");
    expect(retrieved).toBeDefined();
    // Ownership metadata must be stamped authoritatively by the bootstrap —
    // the registry uses it to drive ref-counting and conflict detection when
    // the plugin shuts down or is hot-reloaded.
    expect(retrieved?.origin).toBe("skill");
    expect(retrieved?.ownerSkillId).toBe("alpha-contributor");

    // The tool surfaces in the global `getAllTools()` snapshot, which is
    // what downstream consumers (tool-manifest, session projection) read.
    const names = getAllTools().map((t) => t.name);
    expect(names).toContain("plugin-contrib-tool");
  });

  test("plugin tools are unregistered when shutdown hooks run", async () => {
    const plugin = buildPlugin("bravo-contributor", {
      async init() {},
      tools: [makeFakeTool("bravo-tool")],
    });
    registerPlugin(plugin);

    await bootstrapPlugins(fakeCtx);
    expect(getTool("bravo-tool")).toBeDefined();

    await runShutdownHooks("test-shutdown");

    expect(getTool("bravo-tool")).toBeUndefined();
    expect(getSkillRefCount("bravo-contributor")).toBe(0);
  });

  test("bootstrap is a no-op for plugins that declare no tools", async () => {
    const plugin = buildPlugin("no-tools", { async init() {} });
    registerPlugin(plugin);

    await bootstrapPlugins(fakeCtx);
    // No tool should have been registered.
    expect(getAllTools()).toHaveLength(0);

    // Shutdown must also be safe — `unregisterPluginTools` is idempotent for
    // plugins that never contributed any tools.
    await runShutdownHooks("test-shutdown");
    expect(getAllTools()).toHaveLength(0);
  });

  test("tools declared before init() runs are only visible after bootstrap", async () => {
    // Registration alone must not touch the tool registry — only the
    // bootstrap pass does. This matters because `bootstrapPlugins` runs once
    // at daemon startup after the plugin registry is populated; if
    // registration itself contributed tools, hot-reloading a plugin module
    // during boot would race with `initializeTools()`.
    const plugin = buildPlugin("charlie-contributor", {
      async init() {},
      tools: [makeFakeTool("charlie-tool")],
    });
    registerPlugin(plugin);

    expect(getTool("charlie-tool")).toBeUndefined();

    await bootstrapPlugins(fakeCtx);
    expect(getTool("charlie-tool")).toBeDefined();
  });

  test("tools are only registered after init() succeeds", async () => {
    // A plugin whose init throws must not contribute tools — the bootstrap
    // aborts with a PluginExecutionError, and nothing from this plugin
    // should leak into the tool registry.
    const plugin = buildPlugin("delta-broken", {
      async init() {
        throw new Error("boom");
      },
      tools: [makeFakeTool("delta-tool")],
    });
    registerPlugin(plugin);

    await expect(bootstrapPlugins(fakeCtx)).rejects.toThrow(/delta-broken/);
    expect(getTool("delta-tool")).toBeUndefined();
  });
});

describe("registerPluginTools / unregisterPluginTools helpers", () => {
  beforeEach(() => {
    __resetRegistryForTesting();
  });

  test("registerPluginTools stamps origin and ownerSkillId from the plugin name", () => {
    // Even if the plugin author hands in a tool with no ownership metadata,
    // the helper fills it in so the tool can be unregistered later.
    const accepted = registerPluginTools("my-plugin", [
      makeFakeTool("pt_stamped"),
    ]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.origin).toBe("skill");
    expect(accepted[0]?.ownerSkillId).toBe("my-plugin");

    const retrieved = getTool("pt_stamped");
    expect(retrieved?.origin).toBe("skill");
    expect(retrieved?.ownerSkillId).toBe("my-plugin");
  });

  test("registerPluginTools overwrites any pre-existing ownership metadata", () => {
    // A plugin author could (maliciously or mistakenly) hand in a tool
    // pre-tagged with another skill's ID. The helper must overwrite it so
    // the bootstrap is always the source of truth for ownership.
    const spoofed = makeFakeTool("pt_spoof", {
      origin: "skill",
      ownerSkillId: "some-other-skill",
    });
    registerPluginTools("my-plugin", [spoofed]);
    const retrieved = getTool("pt_spoof");
    expect(retrieved?.ownerSkillId).toBe("my-plugin");
  });

  test("unregisterPluginTools removes the plugin's tools", () => {
    registerPluginTools("rm-plugin", [
      makeFakeTool("pt_rm_a"),
      makeFakeTool("pt_rm_b"),
    ]);
    expect(getTool("pt_rm_a")).toBeDefined();
    expect(getTool("pt_rm_b")).toBeDefined();

    unregisterPluginTools("rm-plugin");

    expect(getTool("pt_rm_a")).toBeUndefined();
    expect(getTool("pt_rm_b")).toBeUndefined();
  });

  test("unregisterPluginTools is a no-op for plugins that never contributed", () => {
    expect(() => unregisterPluginTools("never-registered")).not.toThrow();
  });

  test("ref-counting: repeated registrations require matching unregister calls", () => {
    registerPluginTools("rc-plugin", [makeFakeTool("pt_rc")]);
    registerPluginTools("rc-plugin", [makeFakeTool("pt_rc")]);
    expect(getSkillRefCount("rc-plugin")).toBe(2);

    unregisterPluginTools("rc-plugin");
    expect(getTool("pt_rc")).toBeDefined();

    unregisterPluginTools("rc-plugin");
    expect(getTool("pt_rc")).toBeUndefined();
    expect(getSkillRefCount("rc-plugin")).toBe(0);
  });
});

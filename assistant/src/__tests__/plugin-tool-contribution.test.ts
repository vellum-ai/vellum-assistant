/**
 * Tests for plugin tool contributions (PR 31).
 *
 * Covers the end-to-end flow that lets a plugin declare tools on its
 * manifest and have them surface through the global tool registry:
 *
 * - Registering a plugin with `tools: Tool[]`, running `bootstrapPlugins`,
 *   and observing the contributed tool via `getAllTools()` / `peekTool()`.
 * - Tool ownership (`owner: { kind: "plugin", id: <plugin> }`) recorded
 *   authoritatively by `registerPluginTools` into the registry's
 *   `ownersByName` map (queried via `getToolOwner(name)`), regardless of
 *   what the plugin author set on the incoming object. The `Tool` itself
 *   carries no ownership field — the bootstrap is the only writer.
 * - Shutdown hook unregistering the contributed tools so the registry is
 *   clean again after teardown.
 * - Direct `registerPluginTools` / `unregisterPluginTools` semantics,
 *   including the plugin-scoped ref count.
 *
 * `resetPluginRegistryForTests()` and `__clearRegistryForTesting()` isolate
 * registry state between cases so this file can run alongside other
 * plugin/tool-registry tests without cross-contamination.
 */

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { bootstrapPlugins } from "../daemon/external-plugins-bootstrap.js";
import { RiskLevel } from "../permissions/types.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { InitContext, Plugin } from "../plugins/types.js";
import {
  __clearRegistryForTesting,
  __resetRegistryForTesting,
  getAllTools,
  getPluginRefCount,
  getToolOwner,
  peekTool,
  registerPluginTools,
  unregisterPluginTools,
} from "../tools/registry.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../tools/types.js";

// Redirect plugin-storage-directory creation into a per-process temp tree so
// the test doesn't touch the developer's real ~/.vellum. This matches the
// convention used by plugin-bootstrap.test.ts.
const TEST_WORKSPACE_DIR = join(
  tmpdir(),
  `vellum-plugin-tool-contrib-test-${process.pid}`,
);
process.env.VELLUM_WORKSPACE_DIR = TEST_WORKSPACE_DIR;

function makeFakeTool(name: string, extras: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `Fake ${name}`,
    defaultRiskLevel: RiskLevel.Low,
    executionTarget: "sandbox",
    input_schema: { type: "object", properties: {}, required: [] },
    category: "",
    async execute(
      _input: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolExecutionResult> {
      return { content: "ok", isError: false };
    },
    ...extras,
  };
}

/**
 * Test helper. Accepts the new `hooks` bag and ALSO legacy top-level
 * `init` / `onShutdown` for ergonomics — the helper merges them into a
 * single `hooks` field that matches the runtime Plugin shape.
 */
function buildPlugin(
  name: string,
  extras: Partial<Omit<Plugin, "manifest" | "hooks">> & {
    hooks?: Plugin["hooks"];
    init?: (ctx: InitContext) => Promise<void>;
    onShutdown?: () => Promise<void>;
  } = {},
): Plugin {
  const {
    init: legacyInit,
    onShutdown: legacyOnShutdown,
    hooks: explicitHooks,
    ...rest
  } = extras;
  const mergedHooks: Plugin["hooks"] | undefined =
    legacyInit !== undefined ||
    legacyOnShutdown !== undefined ||
    explicitHooks !== undefined
      ? {
          ...(explicitHooks ?? {}),
          ...(legacyInit !== undefined ? { init: legacyInit } : {}),
          ...(legacyOnShutdown !== undefined
            ? { shutdown: legacyOnShutdown }
            : {}),
        }
      : undefined;
  return {
    manifest: {
      name,
      version: "0.0.1",
    },
    ...rest,
    ...(mergedHooks ? { hooks: mergedHooks } : {}),
  };
}

describe("plugin tool contributions", () => {
  beforeEach(async () => {
    resetPluginRegistryForTests();
    // Clear the tool registry completely so we can make vacuous-free
    // assertions about which tools are present. We don't need any of the
    // core/host tools for these tests.
    __clearRegistryForTesting();
    await rm(TEST_WORKSPACE_DIR, { recursive: true, force: true });
  });

  test("bootstrap registers plugin tools and makes them discoverable", async () => {
    const tool = makeFakeTool("plugin-contrib-tool");
    const plugin = buildPlugin("alpha-contributor", {
      async init() {},
      tools: [tool],
    });
    registerPlugin(plugin);

    await bootstrapPlugins();

    const retrieved = peekTool("plugin-contrib-tool");
    expect(retrieved).toBeDefined();
    // Ownership is recorded authoritatively by the bootstrap into the
    // registry's `ownersByName` map (keyed by tool name, accessed via
    // `getToolOwner(name)`) — the registry uses it to drive ref-counting
    // and conflict detection when the plugin shuts down or is hot-reloaded.
    // Plugin tools live in their own namespace, disjoint from real skills,
    // so a plugin name that happens to match a skill id cannot collide.
    // Ownership is not stamped on the `Tool` object itself.
    expect(getToolOwner("plugin-contrib-tool")).toEqual({
      kind: "plugin",
      id: "alpha-contributor",
    });

    // The tool surfaces in the global `getAllTools()` snapshot, which is
    // what downstream consumers (tool-manifest, session projection) read.
    const names = getAllTools().map((t) => t.name);
    expect(names).toContain("plugin-contrib-tool");
  });

  test("bootstrap is a no-op for plugins that declare no tools", async () => {
    const plugin = buildPlugin("no-tools", { async init() {} });
    registerPlugin(plugin);

    await bootstrapPlugins();
    // `bootstrapPlugins` also registers the first-party defaults (the advisor
    // default contributes the `advisor` tool), so the global tool set is not
    // empty. What matters here is that the no-tools plugin contributed nothing
    // of its own — its tool refcount stays at zero.
    expect(getPluginRefCount("no-tools")).toBe(0);
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

    expect(peekTool("charlie-tool")).toBeUndefined();

    await bootstrapPlugins();
    expect(peekTool("charlie-tool")).toBeDefined();
  });

  test("tools are only registered after init() succeeds", async () => {
    // GIVEN a plugin that declares a tool but throws during init()
    const plugin = buildPlugin("delta-broken", {
      async init() {
        throw new Error("boom");
      },
      tools: [makeFakeTool("delta-tool")],
    });
    registerPlugin(plugin);

    // WHEN bootstrap runs
    // THEN it does not throw — the init failure is contained to this plugin
    await bootstrapPlugins();

    // AND the failing plugin's tool is rolled back, never leaking into the
    // registry
    expect(peekTool("delta-tool")).toBeUndefined();
  });
});

describe("registerPluginTools / unregisterPluginTools helpers", () => {
  beforeEach(() => {
    __resetRegistryForTesting();
  });

  test("registerPluginTools stamps category and records ownership in the registry", () => {
    // Even if the plugin author hands in a tool with no category, the
    // helper fills it in and records ownership in the registry's
    // `ownersByName` map — the tool itself never carries an `owner` field,
    // so plugin authors can't spoof ownership by forging one.
    const accepted = registerPluginTools("my-plugin", [
      makeFakeTool("pt_stamped"),
    ]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.category).toBe("plugin");
    expect(getToolOwner("pt_stamped")).toEqual({
      kind: "plugin",
      id: "my-plugin",
    });

    const retrieved = peekTool("pt_stamped");
    expect(retrieved?.category).toBe("plugin");
  });

  test("registerPluginTools exposes provider-safe aliases for unsafe plugin tool names", async () => {
    const execute = mock(
      async (
        _input: Record<string, unknown>,
        _context: ToolContext,
      ): Promise<ToolExecutionResult> => ({ content: "ok", isError: false }),
    );
    const accepted = registerPluginTools("stripe-plugin", [
      makeFakeTool("Stripe Link CLI", { execute }),
    ]);

    expect(accepted).toHaveLength(1);
    const alias = accepted[0]!.name;
    expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(alias.startsWith("Stripe_Link_CLI__")).toBe(true);
    expect(peekTool(alias)).toBeDefined();
    expect(accepted[0]!.name).toBe(alias);

    await accepted[0]!.execute(
      {},
      {
        workingDir: "/tmp",
        conversationId: "conv-1",
        trustClass: "guardian",
      },
    );

    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("registerPluginTools keeps edge-whitespace tool names distinct", () => {
    const accepted = registerPluginTools("deploy-plugin", [
      makeFakeTool("deploy"),
      makeFakeTool(" deploy "),
    ]);

    expect(accepted).toHaveLength(2);
    const aliases = accepted.map((tool) => tool.name);
    expect(new Set(aliases).size).toBe(2);
    expect(aliases).toContain("deploy");

    const paddedAlias = aliases.find((name) => name !== "deploy");
    expect(paddedAlias).toMatch(/^deploy__[a-f0-9]{12}$/);
    expect(peekTool("deploy")).toBeDefined();
    expect(peekTool(paddedAlias!)).toBeDefined();
  });

  test("registerPluginTools ignores forged ownership fields on the incoming tool", () => {
    // A plugin author could (maliciously or mistakenly) hand in a tool
    // pre-tagged with another skill's or plugin's ID. The `Tool` type now
    // carries no ownership field at all, so any such forgery is purely
    // inert extra data — the registry only populates `ownersByName` from
    // the first argument to `register*Tools`, which is the single source
    // of truth for ownership and cannot be spoofed by forging fields on
    // the manifest.
    //
    // Cast through `unknown` to simulate a hostile or transpiled artifact
    // arriving with extra fields baked in.
    const spoofed = {
      ...makeFakeTool("pt_spoof"),
      origin: "skill",
      owner: { kind: "skill", id: "some-other-skill" },
    } as unknown as Tool;
    registerPluginTools("my-plugin", [spoofed]);
    expect(peekTool("pt_spoof")).toBeDefined();
    expect(getToolOwner("pt_spoof")).toEqual({
      kind: "plugin",
      id: "my-plugin",
    });
  });

  test("unregisterPluginTools removes the plugin's tools", () => {
    registerPluginTools("rm-plugin", [
      makeFakeTool("pt_rm_a"),
      makeFakeTool("pt_rm_b"),
    ]);
    expect(peekTool("pt_rm_a")).toBeDefined();
    expect(peekTool("pt_rm_b")).toBeDefined();

    unregisterPluginTools("rm-plugin");

    expect(peekTool("pt_rm_a")).toBeUndefined();
    expect(peekTool("pt_rm_b")).toBeUndefined();
  });

  test("unregisterPluginTools is a no-op for plugins that never contributed", () => {
    expect(() => unregisterPluginTools("never-registered")).not.toThrow();
  });

  test("ref-counting: repeated registrations require matching unregister calls", () => {
    registerPluginTools("rc-plugin", [makeFakeTool("pt_rc")]);
    registerPluginTools("rc-plugin", [makeFakeTool("pt_rc")]);
    expect(getPluginRefCount("rc-plugin")).toBe(2);

    unregisterPluginTools("rc-plugin");
    expect(peekTool("pt_rc")).toBeDefined();

    unregisterPluginTools("rc-plugin");
    expect(peekTool("pt_rc")).toBeUndefined();
    expect(getPluginRefCount("rc-plugin")).toBe(0);
  });
});

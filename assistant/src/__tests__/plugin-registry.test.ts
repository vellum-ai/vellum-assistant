/**
 * Tests for the plugin registry (PR 13).
 *
 * Covers successful registration, required-field and duplicate-name
 * validation, capability-version negotiation error messaging, injector
 * ordering, and middleware collection order.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  ASSISTANT_API_VERSIONS,
  getInjectors,
  getMiddlewaresFor,
  getRegisteredPlugins,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import {
  type CompactionArgs,
  type CompactionResult,
  type Injector,
  type Middleware,
  type Plugin,
  PluginExecutionError,
} from "../plugins/types.js";

/** Build a minimal, valid plugin with the given name and optional extras. */
function buildPlugin(
  name: string,
  extras: Partial<Omit<Plugin, "manifest">> = {},
  requiresOverride?: Record<string, string>,
): Plugin {
  return {
    manifest: {
      name,
      version: "0.0.1",
      requires: requiresOverride ?? { pluginRuntime: "v1" },
    },
    ...extras,
  };
}

describe("plugin registry", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
  });

  test("registers a minimal plugin successfully", () => {
    const plugin = buildPlugin("alpha");
    registerPlugin(plugin);

    const registered = getRegisteredPlugins();
    expect(registered).toHaveLength(1);
    expect(registered[0]?.manifest.name).toBe("alpha");
  });

  test("throws on duplicate-name registration", () => {
    registerPlugin(buildPlugin("alpha"));
    expect(() => registerPlugin(buildPlugin("alpha"))).toThrow(
      PluginExecutionError,
    );
    expect(() => registerPlugin(buildPlugin("alpha"))).toThrow(
      "already registered",
    );
  });

  test("throws when manifest is missing", () => {
    // Cast through `unknown` to simulate a JS caller passing a malformed plugin.
    expect(() => registerPlugin({} as unknown as Plugin)).toThrow(
      PluginExecutionError,
    );
  });

  test("throws when manifest.name is missing", () => {
    const bad = {
      manifest: {
        version: "0.0.1",
        requires: { pluginRuntime: "v1" },
      },
    } as unknown as Plugin;
    expect(() => registerPlugin(bad)).toThrow(/manifest\.name is required/);
  });

  test("throws when manifest.version is missing", () => {
    const bad = {
      manifest: {
        name: "missing-version",
        requires: { pluginRuntime: "v1" },
      },
    } as unknown as Plugin;
    expect(() => registerPlugin(bad)).toThrow(/manifest\.version is required/);
  });

  test("throws when manifest.requires is missing", () => {
    const bad = {
      manifest: { name: "missing-requires", version: "0.0.1" },
    } as unknown as Plugin;
    expect(() => registerPlugin(bad)).toThrow(/manifest\.requires is required/);
  });

  test("throws when requires.pluginRuntime is missing", () => {
    const plugin = buildPlugin(
      "no-runtime",
      {},
      // Valid shape but no pluginRuntime entry.
      { memoryApi: "v1" },
    );
    expect(() => registerPlugin(plugin)).toThrow(PluginExecutionError);
    expect(() => registerPlugin(plugin)).toThrow(/pluginRuntime/);
  });

  test("throws with version-mismatch message when a required version is not exposed", () => {
    // The assistant seeds memoryApi with ["v1"]. Requesting v2 must fail.
    const plugin = buildPlugin(
      "too-new",
      {},
      {
        pluginRuntime: "v1",
        memoryApi: "v2",
      },
    );

    expect(() => registerPlugin(plugin)).toThrow(PluginExecutionError);

    // Sanity-check the assistant actually exposes only v1 for memoryApi so
    // this test fails loudly if the capability table ever adds v2.
    expect(ASSISTANT_API_VERSIONS.memoryApi).toEqual(["v1"]);

    try {
      registerPlugin(plugin);
      throw new Error("expected registerPlugin to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginExecutionError);
      const msg = (err as PluginExecutionError).message;
      // Error message must reference plugin name, API, required version,
      // and the versions the assistant exposes.
      expect(msg).toContain("too-new");
      expect(msg).toContain("memoryApi");
      expect(msg).toContain("v2");
      expect(msg).toContain("v1");
      expect((err as PluginExecutionError).pluginName).toBe("too-new");
    }
  });

  test("throws with clear message when a required capability is unknown", () => {
    const plugin = buildPlugin(
      "asks-for-mystery",
      {},
      {
        pluginRuntime: "v1",
        thisDoesNotExist: "v1",
      },
    );
    expect(() => registerPlugin(plugin)).toThrow(PluginExecutionError);
    try {
      registerPlugin(plugin);
      throw new Error("expected registerPlugin to throw");
    } catch (err) {
      const msg = (err as PluginExecutionError).message;
      expect(msg).toContain("asks-for-mystery");
      expect(msg).toContain("thisDoesNotExist");
      expect(msg).toContain("(none)");
    }
  });

  test("getInjectors returns injectors sorted by order ascending", () => {
    const high: Injector = {
      name: "high-order",
      order: 20,
      async produce() {
        return null;
      },
    };
    const low: Injector = {
      name: "low-order",
      order: 10,
      async produce() {
        return null;
      },
    };

    // Register the higher-order plugin first so registration order alone
    // would produce the wrong sequence — the test proves sort-by-order wins.
    registerPlugin(buildPlugin("high", { injectors: [high] }));
    registerPlugin(buildPlugin("low", { injectors: [low] }));

    const injectors = getInjectors();
    expect(injectors.map((i) => i.name)).toEqual(["low-order", "high-order"]);
  });

  test("getMiddlewaresFor returns middleware in registration order", () => {
    const firstMw: Middleware<CompactionArgs, CompactionResult> = async (
      args,
      next,
    ) => next(args);
    const secondMw: Middleware<CompactionArgs, CompactionResult> = async (
      args,
      next,
    ) => next(args);

    registerPlugin(
      buildPlugin("plugin-first", { middleware: { compaction: firstMw } }),
    );
    registerPlugin(
      buildPlugin("plugin-second", { middleware: { compaction: secondMw } }),
    );

    const middlewares = getMiddlewaresFor("compaction");
    expect(middlewares).toHaveLength(2);
    // Identity comparison proves the middleware instances come back in
    // registration order — outer→inner composition semantics belong to the
    // pipeline runner (PR 12), not the registry.
    expect(middlewares[0]).toBe(firstMw);
    expect(middlewares[1]).toBe(secondMw);
  });

  test("getMiddlewaresFor skips plugins without a middleware for the pipeline", () => {
    const mw: Middleware<CompactionArgs, CompactionResult> = async (
      args,
      next,
    ) => next(args);
    registerPlugin(buildPlugin("bare"));
    registerPlugin(buildPlugin("has-mw", { middleware: { compaction: mw } }));

    const middlewares = getMiddlewaresFor("compaction");
    expect(middlewares).toHaveLength(1);
    expect(middlewares[0]).toBe(mw);
  });

  test("getRegisteredPlugins reflects registration order", () => {
    registerPlugin(buildPlugin("one"));
    registerPlugin(buildPlugin("two"));
    registerPlugin(buildPlugin("three"));
    expect(getRegisteredPlugins().map((p) => p.manifest.name)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });
});

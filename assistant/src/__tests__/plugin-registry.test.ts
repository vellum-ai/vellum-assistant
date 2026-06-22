/**
 * Tests for the plugin registry (PR 13).
 *
 * Covers successful registration, required-field and duplicate-name
 * validation, capability-version negotiation error messaging, and
 * registration order.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  closeRegistration,
  getRegisteredPlugins,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import { type Plugin, PluginExecutionError } from "../plugins/types.js";

/** Build a minimal, valid plugin with the given name and optional extras. */
function buildPlugin(
  name: string,
  extras: Partial<Omit<Plugin, "manifest">> = {},
): Plugin {
  return {
    manifest: {
      name,
      version: "0.0.1",
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

  test("rejects a late `registerPlugin` call after `closeRegistration`", () => {
    // Models the user-plugin hang: `loadUserPlugins()` timed out awaiting the
    // plugin's dynamic import, called `closeRegistration()`, and returned.
    // The plugin's module evaluation later completes and still tries to
    // register. The latch must reject it so the registry doesn't gain an
    // entry after `bootstrapPlugins()` has walked it.
    closeRegistration();

    expect(() => registerPlugin(buildPlugin("late-arrival"))).toThrow(
      PluginExecutionError,
    );
    expect(() => registerPlugin(buildPlugin("late-arrival"))).toThrow(
      "registration is closed",
    );
    expect(getRegisteredPlugins().map((p) => p.manifest.name)).not.toContain(
      "late-arrival",
    );
  });

  test("`resetPluginRegistryForTests` re-opens the registration window", () => {
    closeRegistration();
    resetPluginRegistryForTests();
    // Without the reset reopening the latch, this registration would throw.
    expect(() => registerPlugin(buildPlugin("after-reset"))).not.toThrow();
    expect(getRegisteredPlugins().map((p) => p.manifest.name)).toContain(
      "after-reset",
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
      },
    } as unknown as Plugin;
    expect(() => registerPlugin(bad)).toThrow(/manifest\.name is required/);
  });

  test("throws on non-kebab-case plugin names (path-traversal guard)", () => {
    // Plugin names flow into filesystem paths (`plugins-data/<name>/`), so the
    // registry must reject anything that could escape the storage directory
    // or otherwise deviate from the kebab-case contract.
    const cases = [
      "../evil",
      "../../etc",
      "evil/with/slashes",
      "has space",
      "Has-Uppercase",
      "-leading-hyphen",
      "trailing-hyphen-",
      "double--hyphen",
      ".",
      "",
    ];
    for (const name of cases) {
      const plugin = buildPlugin(name || "x");
      // Override the name post-build so the empty-string case exercises the
      // same code path as the others (buildPlugin uses the literal value).
      (plugin.manifest as { name: string }).name = name;
      expect(() => registerPlugin(plugin)).toThrow(PluginExecutionError);
    }
  });

  test("accepts valid kebab-case plugin names", () => {
    for (const name of ["a", "abc", "a-b", "a1-b2", "foo-bar-baz"]) {
      resetPluginRegistryForTests();
      expect(() => registerPlugin(buildPlugin(name))).not.toThrow();
    }
  });

  test("throws when manifest.version is missing", () => {
    const bad = {
      manifest: {
        name: "missing-version",
      },
    } as unknown as Plugin;
    expect(() => registerPlugin(bad)).toThrow(/manifest\.version is required/);
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

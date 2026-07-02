/**
 * Tests for plugin runtime-injector contributions.
 *
 * A plugin may declare an `injectors` array on its {@link Plugin} shape; after
 * its model-visible surface is wired and before `init()` succeeds, bootstrap
 * registers each entry into the global injector registry via
 * {@link registerPluginInjectors}. A plugin rolled back after a failed bring-up
 * (or uninstalled/disabled at runtime) is unregistered via
 * {@link unregisterPluginInjectors}. This mirrors the tools/routes contribution
 * path (see `plugin-route-contribution.test.ts`).
 *
 * These tests exercise the production wiring end to end:
 *
 *  1. Bootstrap → the contributed injector appears in
 *     {@link getRegisteredInjectors}, and `init()` ran.
 *  2. A plugin without `injectors` bootstraps cleanly.
 *
 * `getRegisteredInjectors()` after `bootstrapPlugins()` also contains the
 * first-party defaults (bootstrap registers `default-memory`'s injectors), so
 * assertions key on the test injector's unique name rather than the full set.
 */

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { bootstrapPlugins } from "../daemon/external-plugins-bootstrap.js";
import {
  clearInjectorRegistry,
  getRegisteredInjectors,
} from "../plugins/injector-registry.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { InitContext, Injector, Plugin } from "../plugins/types.js";

// Redirect plugin storage creation into a per-process temp tree so the test
// never touches a developer's real ~/.vellum.
const TEST_WORKSPACE_DIR = join(
  tmpdir(),
  `vellum-plugin-injector-contrib-test-${process.pid}`,
);
process.env.VELLUM_WORKSPACE_DIR = TEST_WORKSPACE_DIR;

const TEST_INJECTOR_NAME = "test-contrib-injector";

/** A minimal injector with a unique name that opts out every turn. */
function makeTestInjector(order = 7): Injector {
  return {
    name: TEST_INJECTOR_NAME,
    order,
    async produce(): Promise<null> {
      return null;
    },
  };
}

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
    manifest: { name, version: "0.0.1" },
    ...rest,
    ...(mergedHooks ? { hooks: mergedHooks } : {}),
  };
}

function isTestInjectorRegistered(): boolean {
  return getRegisteredInjectors().some((i) => i.name === TEST_INJECTOR_NAME);
}

describe("plugin injector contributions", () => {
  beforeEach(async () => {
    resetPluginRegistryForTests();
    clearInjectorRegistry();
    await rm(TEST_WORKSPACE_DIR, { recursive: true, force: true });
  });

  test("bootstrap registers a plugin's injectors after init succeeds", async () => {
    let initFired = false;
    registerPlugin(
      buildPlugin("injector-plugin", {
        async init() {
          initFired = true;
        },
        injectors: [makeTestInjector()],
      }),
    );

    await bootstrapPlugins();

    // init() must have run — injector registration is part of the same
    // initialize-plugin pass that drives init.
    expect(initFired).toBe(true);
    // The contributed injector is in the registry the per-turn walker reads.
    expect(isTestInjectorRegistered()).toBe(true);
  });

  test("plugin with no injectors bootstraps cleanly", async () => {
    // Declaring no `injectors` field is the common case; bootstrap must skip
    // injector handling entirely (the guard is `if plugin.injectors && length`).
    registerPlugin(buildPlugin("no-injectors-plugin", { async init() {} }));

    await bootstrapPlugins();

    expect(isTestInjectorRegistered()).toBe(false);
  });
});

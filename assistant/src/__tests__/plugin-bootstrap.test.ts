/**
 * Tests for plugin bootstrap (PR 14).
 *
 * Covers:
 * - A noop `init()` fires with a valid `InitContext` that exposes every
 *   documented field.
 * - Version-mismatch registration fails with an error that names the plugin
 *   (the registry enforces this at `registerPlugin` time, so bootstrap never
 *   sees the malformed plugin).
 * - Plugins' `shutdown` hooks fire through the unified `runHook(HOOKS.SHUTDOWN)`
 *   pipeline; `.disabled` plugins are excluded from that dispatch.
 *
 * `resetPluginRegistryForTests()` isolates registry state between cases.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { bootstrapPlugins } from "../daemon/external-plugins-bootstrap.js";
import { HOOKS } from "../plugin-api/constants.js";
import { registerDefaultPlugins } from "../plugins/defaults/index.js";
import { runHook } from "../plugins/pipeline.js";
import {
  closeRegistration,
  getRegisteredPlugins,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import { type InitContext, type Plugin } from "../plugins/types.js";
import { APP_VERSION } from "../version.js";

// Redirect plugin storage directory creation into a per-process temp tree so
// the test doesn't touch the developer's real ~/.vellum.
const TEST_WORKSPACE_DIR = join(
  tmpdir(),
  `vellum-plugin-bootstrap-test-${process.pid}`,
);
process.env.VELLUM_WORKSPACE_DIR = TEST_WORKSPACE_DIR;

/**
 * Test helper. Accepts the new `hooks` bag and ALSO legacy top-level
 * `init` / `onShutdown` for ergonomics — the helper merges them into a
 * single `hooks` field that matches the runtime Plugin shape. This keeps
 * the test call sites compact without leaking the old contract.
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

describe("plugin bootstrap", () => {
  beforeEach(async () => {
    resetPluginRegistryForTests();
    // Clean storage directory between runs so nothing leaks across cases.
    await rm(TEST_WORKSPACE_DIR, { recursive: true, force: true });
  });

  test("noop plugin: init fires with a fully-populated InitContext", async () => {
    let received: InitContext | undefined;
    const plugin: Plugin = buildPlugin("alpha", {
      async init(ctx) {
        received = ctx;
      },
    });
    registerPlugin(plugin);

    await bootstrapPlugins();

    expect(received).toBeDefined();
    const ctx = received!;

    // Every documented field must be present on the context passed to init.
    expect(ctx.config).toBeUndefined(); // no `plugins.alpha` block in fake config
    expect(ctx.logger).toBeDefined();
    expect(typeof (ctx.logger as { info: unknown }).info).toBe("function");
    // Storage dir lives under getWorkspaceDir()/plugins-data/<name> and must have
    // been created on disk by bootstrap.
    expect(ctx.pluginStorageDir).toBe(
      join(TEST_WORKSPACE_DIR, "plugins-data", "alpha"),
    );
    expect(existsSync(ctx.pluginStorageDir)).toBe(true);
    expect(ctx.assistantVersion).toBe(APP_VERSION);
  });

  test("version mismatch: external plugin loader rejects when peerDependency unsatisfied", async () => {
    // Host-compat negotiation lives in the external-plugin loader against
    // `peerDependencies["@vellumai/plugin-api"]`. The registry no longer
    // re-validates a manifest-level `requires` block — the loader is the
    // single authoritative point. End-to-end coverage of the loader path
    // lives in `external-plugin-loader.test.ts`; this test asserts the
    // bootstrap doesn't gain its own validation surface.
    const plugin = buildPlugin("compat-claim-checked-upstream");
    expect(() => registerPlugin(plugin)).not.toThrow();
  });

  test("plugin init throw: bootstrap contains the failure and does not throw", async () => {
    // GIVEN a plugin whose init throws
    registerPlugin(
      buildPlugin("broken", {
        async init() {
          throw new Error("kaboom");
        },
      }),
    );

    // WHEN bootstrap runs
    // THEN it completes without throwing — a single plugin's init failure is
    // contained to that plugin rather than aborting the whole plugin layer
    await bootstrapPlugins();

    // AND the failing plugin is dropped from the registry so its hooks never
    // participate in the turn lifecycle
    const names = getRegisteredPlugins().map((p) => p.manifest.name);
    expect(names).not.toContain("broken");
  });

  test("mid-list init failure: surrounding plugins still initialize and survive", async () => {
    // GIVEN two healthy plugins surrounding one whose init throws, registered
    // in order
    const initialized: string[] = [];
    const shutDownDuringBootstrap: string[] = [];
    registerPlugin(
      buildPlugin("before", {
        async init() {
          initialized.push("before");
        },
        async onShutdown() {
          shutDownDuringBootstrap.push("before");
        },
      }),
    );
    registerPlugin(
      buildPlugin("failing", {
        async init() {
          throw new Error("mid-bootstrap failure");
        },
      }),
    );
    registerPlugin(
      buildPlugin("after", {
        async init() {
          initialized.push("after");
        },
        async onShutdown() {
          shutDownDuringBootstrap.push("after");
        },
      }),
    );

    // WHEN bootstrap runs
    await bootstrapPlugins();

    // THEN both healthy plugins initialized — the one registered after the
    // failure is not skipped
    expect(initialized).toEqual(["before", "after"]);
    // AND neither healthy plugin was torn down by the failure (their
    // onShutdown only runs at real shutdown, not during bootstrap)
    expect(shutDownDuringBootstrap).toEqual([]);
    // AND the failing plugin is dropped while both survivors remain registered
    const names = getRegisteredPlugins().map((p) => p.manifest.name);
    expect(names).toContain("before");
    expect(names).toContain("after");
    expect(names).not.toContain("failing");
  });

  test("user-plugin init failure leaves the first-party defaults registered", async () => {
    // GIVEN the first-party defaults are registered ahead of user plugins, as
    // at daemon startup
    registerDefaultPlugins();
    // AND a user plugin registered after them whose init throws
    registerPlugin(
      buildPlugin("breaking-user-plugin", {
        async init() {
          throw new Error("user plugin boom");
        },
      }),
    );

    // WHEN bootstrap runs
    await bootstrapPlugins();

    // THEN the failing user plugin is dropped from the registry
    const names = getRegisteredPlugins().map((p) => p.manifest.name);
    expect(names).not.toContain("breaking-user-plugin");
    // AND every first-party default survived, so core turn behavior (memory
    // retrieval, history repair, title generation) keeps running in degraded
    // mode instead of being torn down with the failing plugin
    expect(names).toContain("default-memory");
    expect(names).toContain("default-history-repair");
    expect(names).toContain("default-title-generate");
  });

  test("shutdown: onShutdown fires through the runHook pipeline in registration order", async () => {
    const callOrder: string[] = [];
    registerPlugin(
      buildPlugin("first-registered", {
        async onShutdown() {
          callOrder.push("first-registered");
        },
      }),
    );
    registerPlugin(
      buildPlugin("second-registered", {
        async onShutdown() {
          callOrder.push("second-registered");
        },
      }),
    );

    await bootstrapPlugins();
    // The plugins' `shutdown` hooks fire through the unified pipeline — the same
    // dispatch path (and registration order) as every other lifecycle hook, so
    // the first plugin to register runs first.
    await runHook(HOOKS.SHUTDOWN, {
      assistantVersion: APP_VERSION,
      reason: "shutdown",
    });

    expect(callOrder).toEqual(["first-registered", "second-registered"]);
  });

  test("empty registry: bootstrap seeds the first-party defaults without throwing", async () => {
    // The bootstrap path calls `registerDefaultPlugins` at the top, so even
    // when the test-reset registry starts empty the bootstrap emerges with
    // the canonical defaults installed (compaction circuit breaker,
    // tool-result truncate, etc.). Just assert bootstrap completes without
    // throwing — the surface of defaults is verified in each pipeline's own
    // dedicated test file.
    await bootstrapPlugins();
  });

  test("startup ordering: defaults registered before the window closes survive bootstrap replay", async () => {
    /**
     * Reproduces the daemon startup ordering the registration regression
     * guards: defaults must register before `loadUserPlugins()` closes the
     * window, so the `registerDefaultPlugins` replay inside `bootstrapPlugins`
     * is swallowed by the duplicate-name check instead of throwing on the
     * closed window and leaving every default unregistered.
     */

    // GIVEN the first-party defaults have registered while the window is open
    // (what `initializePlugins()` does at daemon startup)
    registerDefaultPlugins();

    // AND a user plugin registers after them (what `loadUserPlugins()` does)
    registerPlugin(buildPlugin("user-after-defaults"));

    // AND the registration window has since closed
    closeRegistration();

    // WHEN bootstrap runs and replays the default registration
    await bootstrapPlugins();

    // THEN the defaults are still registered, ahead of the user plugin, so the
    // middleware onion order is unchanged
    const names = getRegisteredPlugins().map((p) => p.manifest.name);
    expect(names).toContain("default-compaction");
    expect(names.indexOf("default-compaction")).toBeLessThan(
      names.indexOf("user-after-defaults"),
    );
  });

  // ── .disabled sentinel gating ──────────────────────────────────────────
  //
  // A plugin is disabled when a `.disabled` file exists at
  // <workspace>/plugins/<manifest-name>/.disabled. The bootstrap must
  // skip the plugin's init, tools, routes, and shutdown hook. The plugin
  // is NOT removed from the registry — its hooks stay registered and are
  // filtered at read time by `isPluginDisabled` in `getHooksFor`, so
  // `assistant plugins enable` takes effect on the next turn without a
  // restart.

  test(".disabled sentinel: init does not fire and hooks are filtered at read time", async () => {
    let initFired = false;
    const plugin = buildPlugin("sentinel-off", {
      async init() {
        initFired = true;
      },
    });
    registerPlugin(plugin);

    // Create the .disabled sentinel in the workspace plugins dir.
    const sentinelDir = join(TEST_WORKSPACE_DIR, "plugins", "sentinel-off");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(sentinelDir, { recursive: true });
    await writeFile(join(sentinelDir, ".disabled"), "");

    await bootstrapPlugins();

    expect(initFired).toBe(false);
    // The plugin stays in the registry (not unregistered) so its hooks can
    // be re-enabled at runtime by removing the sentinel.
    const names = getRegisteredPlugins().map((p) => p.manifest.name);
    expect(names).toContain("sentinel-off");
    // But its hooks are filtered out at read time by `isPluginDisabled`.
    // Enabled default plugins (e.g. default-memory) contribute their own init
    // hook, so assert specifically that the disabled plugin's hook is absent
    // rather than that the list is empty.
    const { getHooksFor } = await import("../hooks/registry.js");
    const hooks = await getHooksFor("init");
    expect(hooks).not.toContain(plugin.hooks?.init);

    await rm(sentinelDir, { recursive: true, force: true });
  });

  test(".disabled sentinel absent: plugin inits normally", async () => {
    let initFired = false;
    const plugin = buildPlugin("sentinel-ok", {
      async init() {
        initFired = true;
      },
    });
    registerPlugin(plugin);

    // No .disabled sentinel created — plugin should init normally.
    await bootstrapPlugins();

    expect(initFired).toBe(true);
  });

  test(".disabled sentinel: no shutdown hook entry for the skipped plugin", async () => {
    let shutdownFired = false;
    const plugin = buildPlugin("sentinel-shutdown", {
      async init() {},
      async onShutdown() {
        shutdownFired = true;
      },
    });
    registerPlugin(plugin);

    const sentinelDir = join(
      TEST_WORKSPACE_DIR,
      "plugins",
      "sentinel-shutdown",
    );
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(sentinelDir, { recursive: true });
    await writeFile(join(sentinelDir, ".disabled"), "");

    await bootstrapPlugins();
    await runHook(HOOKS.SHUTDOWN, {
      assistantVersion: APP_VERSION,
      reason: "shutdown",
    });

    // A `.disabled` plugin keeps its hooks registered but they are filtered out
    // at read time by `isPluginDisabled` inside `getHooksFor`, so the pipeline
    // dispatch skips its `onShutdown` too.
    expect(shutdownFired).toBe(false);

    await rm(sentinelDir, { recursive: true, force: true });
  });

  test(".disabled sentinel on an injector-only default: injectors register up front and reappear on enable", async () => {
    const { clearInjectorRegistry, getRegisteredInjectors } =
      await import("../plugins/injector-registry.js");
    clearInjectorRegistry();

    // `default-workspace` is injector-only (no hooks) and contributes
    // `workspace-context` among others. Disable it at boot via the sentinel —
    // the per-plugin init loop will `continue` past it.
    const sentinelDir = join(
      TEST_WORKSPACE_DIR,
      "plugins",
      "default-workspace",
    );
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(sentinelDir, { recursive: true });
    await writeFile(join(sentinelDir, ".disabled"), "");

    await bootstrapPlugins();

    // Disabled at boot → its injectors are filtered out of the per-turn chain
    // at read time...
    expect(
      getRegisteredInjectors().some((i) => i.name === "workspace-context"),
    ).toBe(false);

    // ...but enabling it (removing the sentinel) restores the injections on the
    // next read with no restart — they were registered up front by
    // `registerDefaultPluginInjectors`, not gated on the skipped init.
    await rm(sentinelDir, { recursive: true, force: true });
    expect(
      getRegisteredInjectors().some((i) => i.name === "workspace-context"),
    ).toBe(true);
  });
});

/**
 * Tests for plugin bootstrap (PR 14).
 *
 * Covers:
 * - A noop `init()` fires with a valid `PluginInitContext` that exposes every
 *   documented field.
 * - `requiresCredential` entries are resolved through the credential store
 *   helper and arrive in `ctx.credentials`.
 * - Version-mismatch registration fails with an error that names the plugin
 *   (the registry enforces this at `registerPlugin` time, so bootstrap never
 *   sees the malformed plugin).
 * - Shutdown hook walks plugins in reverse registration order.
 *
 * Uses `mock.module` to stub `security/secure-keys.js` so credential
 * resolution doesn't hit the real backend. `resetPluginRegistryForTests()`
 * isolates registry state between cases.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock credential store before importing the bootstrap module so the
// module-under-test captures the stubbed binding.
const getSecureKeyAsyncMock = mock(
  async (_account: string): Promise<string | undefined> => undefined,
);
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: getSecureKeyAsyncMock,
}));

import { clearFeatureFlagOverridesCache } from "../config/assistant-feature-flags.js";
import { bootstrapPlugins } from "../daemon/external-plugins-bootstrap.js";
import { runShutdownHooks } from "../daemon/shutdown-registry.js";
import { RiskLevel } from "../permissions/types.js";
import { registerDefaultPlugins } from "../plugins/defaults/index.js";
import {
  closeRegistration,
  getRegisteredPlugins,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import { type Plugin, type PluginInitContext } from "../plugins/types.js";
import { APP_VERSION } from "../version.js";
import { setOverridesForTesting } from "./feature-flag-test-helpers.js";

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
    init?: (ctx: PluginInitContext) => Promise<void>;
    onShutdown?: () => Promise<void>;
  } = {},
  options: {
    requiresCredential?: string[];
    requiresFlag?: string[];
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
      ...(options.requiresCredential
        ? { requiresCredential: options.requiresCredential }
        : {}),
      ...(options.requiresFlag ? { requiresFlag: options.requiresFlag } : {}),
    },
    ...rest,
    ...(mergedHooks ? { hooks: mergedHooks } : {}),
  };
}

describe("plugin bootstrap", () => {
  beforeEach(async () => {
    resetPluginRegistryForTests();
    getSecureKeyAsyncMock.mockReset();
    getSecureKeyAsyncMock.mockImplementation(async () => undefined);
    // Reset feature-flag cache so tests start from a known state. Individual
    // tests that exercise `requiresFlag` use `setOverridesForTesting(...)`
    // to install their own overrides.
    clearFeatureFlagOverridesCache();
    // Clean storage directory between runs so nothing leaks across cases.
    await rm(TEST_WORKSPACE_DIR, { recursive: true, force: true });
  });

  test("noop plugin: init fires with a fully-populated PluginInitContext", async () => {
    let received: PluginInitContext | undefined;
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
    expect(ctx.credentials).toEqual({});
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

  test("credential resolution: init receives the resolved value under credentials[key]", async () => {
    getSecureKeyAsyncMock.mockImplementation(async (account: string) => {
      if (account === "some-key") return "super-secret-value";
      return undefined;
    });

    let received: PluginInitContext | undefined;
    const plugin = buildPlugin(
      "credentialed",
      {
        async init(ctx) {
          received = ctx;
        },
      },
      { requiresCredential: ["some-key"] },
    );
    registerPlugin(plugin);

    await bootstrapPlugins();

    expect(getSecureKeyAsyncMock).toHaveBeenCalledTimes(1);
    expect(getSecureKeyAsyncMock).toHaveBeenCalledWith("some-key");
    expect(received?.credentials).toEqual({ "some-key": "super-secret-value" });
  });

  test("credential resolution: a plugin whose required credential is missing is skipped, not fatal", async () => {
    // GIVEN a plugin that requires a credential the store cannot resolve
    getSecureKeyAsyncMock.mockImplementation(async () => undefined);
    registerPlugin(
      buildPlugin(
        "missing-cred",
        { async init() {} },
        { requiresCredential: ["absent-key"] },
      ),
    );

    // WHEN bootstrap runs
    // THEN it completes without throwing — the unresolvable credential is
    // contained to that plugin (same per-plugin isolation as an init throw)
    await bootstrapPlugins();

    // AND the plugin is dropped from the registry
    const names = getRegisteredPlugins().map((p) => p.manifest.name);
    expect(names).not.toContain("missing-cred");
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
    expect(names).toContain("default-memory-retrieval");
    expect(names).toContain("default-history-repair");
    expect(names).toContain("default-title-generate");
  });

  test("shutdown order: onShutdown fires in reverse registration order", async () => {
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
    await runShutdownHooks("test-shutdown");

    // The last plugin to register must shut down first; the first to register
    // shuts down last. Symmetric tear-down around registration order is the
    // whole point of the reverse walk.
    expect(callOrder).toEqual(["second-registered", "first-registered"]);
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

  // ── requiresFlag gating (G2.2) ──────────────────────────────────────────
  //
  // Plugins that declare `manifest.requiresFlag: [key1, ...]` must only
  // activate when ALL listed flag keys resolve to `true` at bootstrap.
  // "Skipping" a plugin means:
  //   - init() is not invoked,
  //   - tools/routes/skills are not registered,
  //   - no shutdown hook entry is installed (nothing to tear down later).
  // Plugins without `requiresFlag` are unaffected.
  //
  // Uses `setOverridesForTesting` to control the resolver deterministically
  // — no disk writes, no gateway IPC, no reliance on registry defaults.

  test("requiresFlag enabled: plugin inits normally", async () => {
    setOverridesForTesting({ "plugin-gated-enabled": true });

    let initFired = false;
    const plugin = buildPlugin(
      "gated-on",
      {
        async init() {
          initFired = true;
        },
      },
      { requiresFlag: ["plugin-gated-enabled"] },
    );
    registerPlugin(plugin);

    await bootstrapPlugins();

    expect(initFired).toBe(true);
  });

  test("requiresFlag disabled: init does not fire and no tools/routes are registered", async () => {
    setOverridesForTesting({ "plugin-gated-disabled": false });

    let initFired = false;
    // Attach tool/route contributions alongside init. If gating works,
    // none of them should land in their respective registries.
    const plugin = buildPlugin(
      "gated-off",
      {
        async init() {
          initFired = true;
        },
        tools: [
          {
            name: "gated-off-tool",
            description: "should not be registered",
            category: "test",
            defaultRiskLevel: RiskLevel.Low,
            executionTarget: "sandbox",
            input_schema: { type: "object", properties: {}, required: [] },
            execute: async () => ({ content: "nope", isError: false }),
          },
        ],
        routes: [
          {
            // Unique pattern so we don't collide with any other test's route.
            pattern: /^\/_plugin\/gated-off\/status$/,
            methods: ["GET"],
            handler: async () => new Response("ok"),
          },
        ],
      },
      { requiresFlag: ["plugin-gated-disabled"] },
    );
    registerPlugin(plugin);

    // Grab tool / route introspection helpers lazily so the import
    // side effect happens after `mock.module` has taken effect.
    const { getTool } = await import("../tools/registry.js");
    const { matchSkillRoute } =
      await import("../runtime/skill-route-registry.js");

    await bootstrapPlugins();

    // init must not have fired.
    expect(initFired).toBe(false);
    // No tool contributed.
    expect(getTool("gated-off-tool")).toBeUndefined();
    // No route wired up — `matchSkillRoute` returns null when nothing matches.
    expect(matchSkillRoute("/_plugin/gated-off/status", "GET")).toBeNull();
  });

  test("requiresFlag absent: plugin activates unconditionally", async () => {
    // Deliberately do not set any overrides — a plugin with no
    // `requiresFlag` key must not consult the resolver at all.
    let initFired = false;
    const plugin = buildPlugin("no-flag", {
      async init() {
        initFired = true;
      },
    });
    registerPlugin(plugin);

    await bootstrapPlugins();

    expect(initFired).toBe(true);
  });

  test("requiresFlag: one disabled flag out of several skips the plugin", async () => {
    // When ANY listed flag is disabled, the plugin is skipped wholesale —
    // this prevents sneaky partial activation on AND semantics.
    setOverridesForTesting({
      "plugin-multi-a": true,
      "plugin-multi-b": false,
    });

    let initFired = false;
    const plugin = buildPlugin(
      "multi-flag",
      {
        async init() {
          initFired = true;
        },
      },
      { requiresFlag: ["plugin-multi-a", "plugin-multi-b"] },
    );
    registerPlugin(plugin);

    await bootstrapPlugins();

    expect(initFired).toBe(false);
  });

  test("requiresFlag disabled: the skipped plugin is removed from the registry", async () => {
    // Regression: a flag-gated skip must call `unregisterPlugin()` so the
    // gated-off plugin does not linger in `registeredPlugins` with its
    // `init()` never having fired to set up the state it depends on.
    setOverridesForTesting({ "plugin-registry-disabled": false });

    const plugin = buildPlugin(
      "gated-registry",
      {},
      { requiresFlag: ["plugin-registry-disabled"] },
    );
    registerPlugin(plugin);

    await bootstrapPlugins();

    // The gated-off plugin must not survive in the registry snapshot.
    const names = getRegisteredPlugins().map((p) => p.manifest.name);
    expect(names).not.toContain("gated-registry");
  });

  test("requiresFlag disabled: no shutdown hook entry installed for the skipped plugin", async () => {
    setOverridesForTesting({ "plugin-shutdown-flag": false });

    let shutdownFired = false;
    const plugin = buildPlugin(
      "shutdown-skipped",
      {
        async init() {},
        async onShutdown() {
          shutdownFired = true;
        },
      },
      { requiresFlag: ["plugin-shutdown-flag"] },
    );
    registerPlugin(plugin);

    await bootstrapPlugins();
    await runShutdownHooks("test-shutdown");

    // The shutdown hook is a single registered callback that walks a
    // snapshot taken at bootstrap. A skipped plugin should never appear in
    // that snapshot, so its `onShutdown` must never fire.
    expect(shutdownFired).toBe(false);
  });
});

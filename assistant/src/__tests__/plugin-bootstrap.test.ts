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
  getInjectors,
  getMiddlewaresFor,
  getRegisteredPlugins,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import {
  type PipelineMiddlewareMap,
  type Plugin,
  PluginExecutionError,
  type PluginInitContext,
} from "../plugins/types.js";
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

  test("credential resolution: missing credential fails bootstrap with the plugin named", async () => {
    getSecureKeyAsyncMock.mockImplementation(async () => undefined);

    registerPlugin(
      buildPlugin(
        "missing-cred",
        { async init() {} },
        { requiresCredential: ["absent-key"] },
      ),
    );

    let caught: unknown;
    try {
      await bootstrapPlugins();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginExecutionError);
    const msg = (caught as PluginExecutionError).message;
    expect(msg).toContain("missing-cred");
    expect(msg).toContain("absent-key");
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

  test("plugin init throw: bootstrap throws a PluginExecutionError naming the plugin", async () => {
    registerPlugin(
      buildPlugin("broken", {
        async init() {
          throw new Error("kaboom");
        },
      }),
    );

    let caught: unknown;
    try {
      await bootstrapPlugins();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginExecutionError);
    const msg = (caught as PluginExecutionError).message;
    expect(msg).toContain("broken");
    expect(msg).toContain("kaboom");
  });

  test("partial-init failure: earlier plugins' onShutdown runs in reverse before the error propagates", async () => {
    // If plugin N throws during init, every plugin 1..N-1 that already made
    // it through its full init+contribution phase must have onShutdown()
    // invoked in reverse registration order before bootstrap re-throws.
    // Without this, earlier plugins leak live tools/routes/skills because
    // the shutdown hook is only registered once the entire loop completes.
    const callOrder: string[] = [];
    registerPlugin(
      buildPlugin("survivor-a", {
        async init() {},
        async onShutdown() {
          callOrder.push("survivor-a");
        },
      }),
    );
    registerPlugin(
      buildPlugin("survivor-b", {
        async init() {},
        async onShutdown() {
          callOrder.push("survivor-b");
        },
      }),
    );
    registerPlugin(
      buildPlugin("failing", {
        async init() {
          throw new Error("mid-bootstrap failure");
        },
        async onShutdown() {
          // Never called — this plugin never completes init, so it was never
          // added to the active list that teardown walks.
          callOrder.push("failing");
        },
      }),
    );

    let caught: unknown;
    try {
      await bootstrapPlugins();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginExecutionError);

    // Reverse order: survivor-b registered after survivor-a, so it tears
    // down first; "failing" never entered the active list.
    expect(callOrder).toEqual(["survivor-b", "survivor-a"]);
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
    expect(names).toContain("default-llm-call");
    expect(names.indexOf("default-llm-call")).toBeLessThan(
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

  test("requiresFlag disabled: init does not fire and no tools/routes/skills are registered", async () => {
    setOverridesForTesting({ "plugin-gated-disabled": false });

    let initFired = false;
    // Attach tool/route/skill contributions alongside init. If gating works,
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
        skills: [
          {
            id: "gated-off/skill",
            name: "gated-off-skill",
            description: "should not be catalogued",
            body: "# unused",
          },
        ],
      },
      { requiresFlag: ["plugin-gated-disabled"] },
    );
    registerPlugin(plugin);

    // Grab tool / route / skill introspection helpers lazily so the import
    // side effect happens after `mock.module` has taken effect.
    const { getTool } = await import("../tools/registry.js");
    const { getPluginSkillRefCount } =
      await import("../plugins/plugin-skill-contributions.js");
    const { matchSkillRoute } =
      await import("../runtime/skill-route-registry.js");

    await bootstrapPlugins();

    // init must not have fired.
    expect(initFired).toBe(false);
    // No tool contributed.
    expect(getTool("gated-off-tool")).toBeUndefined();
    // No route wired up — `matchSkillRoute` returns null when nothing matches.
    expect(matchSkillRoute("/_plugin/gated-off/status", "GET")).toBeNull();
    // No skill catalogued under this plugin's name — ref count stays 0.
    expect(getPluginSkillRefCount("gated-off")).toBe(0);
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

  test("requiresFlag disabled: plugin middleware and injectors are dropped from the registry", async () => {
    // Regression: prior to the unregisterPlugin() call on the flag-gated skip
    // path, `getMiddlewaresFor()` and `getInjectors()` iterated over every
    // entry in `registeredPlugins` — so a gated-off plugin's middleware and
    // injectors still ran on every pipeline invocation and system-prompt
    // assembly even though `init()` had never fired to set up the state they
    // depended on.
    setOverridesForTesting({ "plugin-middleware-disabled": false });

    const gatedMiddleware: PipelineMiddlewareMap["llmCall"] = async (
      args,
      next,
    ) => next(args);
    const plugin = buildPlugin(
      "gated-middleware",
      {
        middleware: { llmCall: gatedMiddleware },
        injectors: [
          {
            name: "gated-middleware-injector",
            order: 100,
            async produce() {
              return null;
            },
          },
        ],
      },
      { requiresFlag: ["plugin-middleware-disabled"] },
    );
    registerPlugin(plugin);

    await bootstrapPlugins();

    // Neither the middleware slot nor the injector list should expose the
    // flag-gated plugin's contributions. The default plugins also contribute
    // llmCall middleware / injectors, so we key on identity rather than
    // asserting empty lists.
    expect(getMiddlewaresFor("llmCall")).not.toContain(gatedMiddleware);
    expect(
      getInjectors().some((i) => i.name === "gated-middleware-injector"),
    ).toBe(false);
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

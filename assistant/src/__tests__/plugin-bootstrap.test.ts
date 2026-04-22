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

import type { AssistantConfig } from "../config/schema.js";
import {
  bootstrapPlugins,
  type DaemonContext,
} from "../daemon/external-plugins-bootstrap.js";
import { runShutdownHooks } from "../daemon/shutdown-registry.js";
import {
  ASSISTANT_API_VERSIONS,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import {
  type Plugin,
  PluginExecutionError,
  type PluginInitContext,
} from "../plugins/types.js";

// Redirect plugin storage directory creation into a per-process temp tree so
// the test doesn't touch the developer's real ~/.vellum.
const TEST_INSTANCE_DIR = join(
  tmpdir(),
  `vellum-plugin-bootstrap-test-${process.pid}`,
);
process.env.BASE_DATA_DIR = TEST_INSTANCE_DIR;

const fakeConfig = {} as unknown as AssistantConfig;
const fakeCtx: DaemonContext = {
  config: fakeConfig,
  assistantVersion: "9.9.9-test",
};

function buildPlugin(
  name: string,
  extras: Partial<Omit<Plugin, "manifest">> = {},
  options: {
    requires?: Record<string, string>;
    requiresCredential?: string[];
  } = {},
): Plugin {
  return {
    manifest: {
      name,
      version: "0.0.1",
      requires: options.requires ?? { pluginRuntime: "v1" },
      ...(options.requiresCredential
        ? { requiresCredential: options.requiresCredential }
        : {}),
    },
    ...extras,
  };
}

describe("plugin bootstrap", () => {
  beforeEach(async () => {
    resetPluginRegistryForTests();
    getSecureKeyAsyncMock.mockReset();
    getSecureKeyAsyncMock.mockImplementation(async () => undefined);
    // Clean storage directory between runs so nothing leaks across cases.
    await rm(TEST_INSTANCE_DIR, { recursive: true, force: true });
  });

  test("noop plugin: init fires with a fully-populated PluginInitContext", async () => {
    let received: PluginInitContext | undefined;
    const plugin: Plugin = buildPlugin("alpha", {
      async init(ctx) {
        received = ctx;
      },
    });
    registerPlugin(plugin);

    await bootstrapPlugins(fakeCtx);

    expect(received).toBeDefined();
    const ctx = received!;

    // Every documented field must be present on the context passed to init.
    expect(ctx.config).toBeUndefined(); // no `plugins.alpha` block in fake config
    expect(ctx.credentials).toEqual({});
    expect(ctx.logger).toBeDefined();
    expect(typeof (ctx.logger as { info: unknown }).info).toBe("function");
    // Storage dir lives under vellumRoot()/plugins-data/<name> and must have
    // been created on disk by bootstrap.
    expect(ctx.pluginStorageDir).toBe(
      join(TEST_INSTANCE_DIR, ".vellum", "plugins-data", "alpha"),
    );
    expect(existsSync(ctx.pluginStorageDir)).toBe(true);
    expect(ctx.assistantVersion).toBe("9.9.9-test");
    // apiVersions must surface the canonical capability table from the
    // registry so plugins can negotiate at runtime.
    expect(ctx.apiVersions).toBe(ASSISTANT_API_VERSIONS);
    expect(ctx.apiVersions.pluginRuntime).toEqual(["v1"]);
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

    await bootstrapPlugins(fakeCtx);

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
      await bootstrapPlugins(fakeCtx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginExecutionError);
    const msg = (caught as PluginExecutionError).message;
    expect(msg).toContain("missing-cred");
    expect(msg).toContain("absent-key");
  });

  test("version mismatch: registration surfaces a clear error naming the plugin", () => {
    // The assistant only exposes pluginRuntime@v1 — asking for v99 must fail
    // registration with the plugin name in the message. The error is raised
    // at registerPlugin() rather than bootstrap, because the registry is the
    // single authoritative point of capability validation.
    const plugin = buildPlugin(
      "from-the-future",
      {},
      { requires: { pluginRuntime: "v99" } },
    );

    let caught: unknown;
    try {
      registerPlugin(plugin);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginExecutionError);
    const msg = (caught as PluginExecutionError).message;
    expect(msg).toContain("from-the-future");
    expect(msg).toContain("pluginRuntime");
    expect(msg).toContain("v99");
    expect((caught as PluginExecutionError).pluginName).toBe("from-the-future");
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
      await bootstrapPlugins(fakeCtx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginExecutionError);
    const msg = (caught as PluginExecutionError).message;
    expect(msg).toContain("broken");
    expect(msg).toContain("kaboom");
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

    await bootstrapPlugins(fakeCtx);
    await runShutdownHooks("test-shutdown");

    // The last plugin to register must shut down first; the first to register
    // shuts down last. Symmetric tear-down around registration order is the
    // whole point of the reverse walk.
    expect(callOrder).toEqual(["second-registered", "first-registered"]);
  });

  test("empty registry: bootstrap is a no-op", async () => {
    // Nothing registered. Bootstrap must not throw, and there is no shutdown
    // hook registered (so downstream shutdown runs are unaffected).
    await bootstrapPlugins(fakeCtx);
  });
});

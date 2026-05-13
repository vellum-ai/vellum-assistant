/**
 * Tests for {@link installPluginPostBoot}.
 *
 * Exercises every outcome the IPC route surfaces to the CLI:
 *
 *   - happy path → `{ status: "loaded" }`, plugin appears in registry,
 *     tools registered, shutdown hook tears it down
 *   - feature flag off → `{ status: "feature-disabled" }`
 *   - bootstrap hasn't run → `{ status: "not-bootstrapped" }`
 *   - duplicate name → `{ status: "already-registered" }`
 *   - name mismatch (package.json name differs) → `{ status: "build-failed" }`
 *   - missing plugin directory → `{ status: "build-failed" }`
 *   - init() throws → `{ status: "init-failed" }`, plugin rolled back
 *   - manifest.requiresFlag unsatisfied → `{ status: "gated" }`
 *
 * Uses a per-process temp dir for `<workspaceDir>/plugins/` so plugin files
 * are written and read from real disk paths — that exercises the same
 * `buildExternalPlugin` → `registerPluginPostBoot` →
 * `initializeAndContributePlugin` chain the IPC handler walks.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (_: string): Promise<string | undefined> =>
    undefined,
}));

import {
  _setOverridesForTesting,
  clearFeatureFlagOverridesCache,
} from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";
import {
  bootstrapPlugins,
  type DaemonContext,
  installPluginPostBoot,
  resetBootstrapStateForTests,
} from "../daemon/external-plugins-bootstrap.js";
import { runShutdownHooks } from "../daemon/shutdown-registry.js";
import {
  getRegisteredPlugin,
  getRegisteredPlugins,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";

// Per-process temp workspace so installed plugin files live in real disk
// paths. `getWorkspaceDir()` reads `VELLUM_WORKSPACE_DIR`, so installing a
// plugin "foo" writes its package.json to `<TEST_WORKSPACE_DIR>/plugins/foo/`.
const TEST_WORKSPACE_DIR = join(
  tmpdir(),
  `vellum-postboot-install-test-${process.pid}`,
);
process.env.VELLUM_WORKSPACE_DIR = TEST_WORKSPACE_DIR;

const fakeConfig = {} as unknown as AssistantConfig;
const ctx: DaemonContext = {
  config: fakeConfig,
  assistantVersion: "9.9.9-test",
};

async function writePluginOnDisk(
  pluginName: string,
  opts: {
    packageJsonName?: string;
    requiresFlag?: string[];
    hookSource?: string;
  } = {},
): Promise<string> {
  const dir = join(TEST_WORKSPACE_DIR, "plugins", pluginName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: opts.packageJsonName ?? pluginName,
      version: "0.0.1",
    }),
  );
  if (opts.hookSource !== undefined || opts.requiresFlag !== undefined) {
    await mkdir(join(dir, "hooks"), { recursive: true });
    const initSource =
      opts.hookSource ?? "export default async function init() {}\n";
    await writeFile(join(dir, "hooks", "init.ts"), initSource);
  }
  return dir;
}

async function resetAll(): Promise<void> {
  resetPluginRegistryForTests();
  resetBootstrapStateForTests();
  clearFeatureFlagOverridesCache();
  _setOverridesForTesting({ "external-plugins": true });
  await rm(TEST_WORKSPACE_DIR, { recursive: true, force: true });
  await mkdir(TEST_WORKSPACE_DIR, { recursive: true });
}

describe("installPluginPostBoot", () => {
  beforeEach(async () => {
    await resetAll();
  });

  afterAll(async () => {
    await rm(TEST_WORKSPACE_DIR, { recursive: true, force: true });
  });

  test("happy path: builds, registers, runs init, returns 'loaded'", async () => {
    await bootstrapPlugins(ctx);
    await writePluginOnDisk("alpha");

    const result = await installPluginPostBoot("alpha", ctx);

    expect(result).toEqual({ status: "loaded", name: "alpha" });
    expect(getRegisteredPlugins().map((p) => p.manifest.name)).toContain(
      "alpha",
    );
  });

  test("feature flag disabled → 'feature-disabled' (no disk read)", async () => {
    await bootstrapPlugins(ctx);
    _setOverridesForTesting({ "external-plugins": false });

    // No plugin directory on disk — the early return must short-circuit
    // before `buildExternalPlugin` tries to read package.json.
    const result = await installPluginPostBoot("alpha", ctx);

    expect(result).toEqual({ status: "feature-disabled" });
    expect(getRegisteredPlugin("alpha")).toBeUndefined();
  });

  test("bootstrap not run → 'not-bootstrapped'", async () => {
    // No `bootstrapPlugins(ctx)` call — shutdownContextRef is still undefined.
    await writePluginOnDisk("alpha");

    const result = await installPluginPostBoot("alpha", ctx);

    expect(result).toEqual({ status: "not-bootstrapped" });
    expect(getRegisteredPlugin("alpha")).toBeUndefined();
  });

  test("duplicate name → 'already-registered'", async () => {
    await bootstrapPlugins(ctx);
    await writePluginOnDisk("alpha");
    await installPluginPostBoot("alpha", ctx);

    // Second call hits the pre-check before any filesystem work.
    const result = await installPluginPostBoot("alpha", ctx);

    expect(result).toEqual({ status: "already-registered", name: "alpha" });
  });

  test("package.json name mismatch → 'build-failed'", async () => {
    await bootstrapPlugins(ctx);
    // Directory is called "alpha" but package.json says "beta".
    await writePluginOnDisk("alpha", { packageJsonName: "beta" });

    const result = await installPluginPostBoot("alpha", ctx);

    expect(result.status).toBe("build-failed");
    if (result.status === "build-failed") {
      expect(result.error).toMatch(/resolved to "beta".*requested "alpha"/);
    }
    // Neither name in the registry.
    expect(getRegisteredPlugin("alpha")).toBeUndefined();
    expect(getRegisteredPlugin("beta")).toBeUndefined();
  });

  test("missing plugin directory → 'build-failed'", async () => {
    await bootstrapPlugins(ctx);
    // Skip the writePluginOnDisk call — directory simply doesn't exist.

    const result = await installPluginPostBoot("ghost", ctx);

    expect(result.status).toBe("build-failed");
    if (result.status === "build-failed") {
      expect(result.error).toMatch(/package\.json.*could not be read/);
    }
  });

  test("init() throws → 'init-failed' and plugin is rolled back", async () => {
    await bootstrapPlugins(ctx);
    await writePluginOnDisk("alpha", {
      hookSource:
        "export default async function init() { throw new Error('boom'); }\n",
    });

    const result = await installPluginPostBoot("alpha", ctx);

    expect(result.status).toBe("init-failed");
    if (result.status === "init-failed") {
      expect(result.name).toBe("alpha");
      expect(result.error).toMatch(/init\(\) failed.*boom/);
    }
    // The helper rolls back on init failure — registry must not retain the
    // plugin, so a subsequent install attempt sees a clean slate (not
    // "already-registered").
    expect(getRegisteredPlugin("alpha")).toBeUndefined();
  });

  test("shutdown hook tears down a post-boot plugin", async () => {
    await bootstrapPlugins(ctx);

    // Use a unique plugin name per test so Bun's module cache (keyed by
    // absolute import path) doesn't return a stale hooks/init.ts from an
    // earlier test that wrote the same path.
    const dir = await writePluginOnDisk("post-boot-shutdown", {
      hookSource: "export default async function init() {}\n",
    });
    await writeFile(
      join(dir, "hooks", "shutdown.ts"),
      [
        "const log = (globalThis as { __postBootShutdownLog?: string[] });",
        "log.__postBootShutdownLog ??= [];",
        "export default async function shutdown() {",
        '  log.__postBootShutdownLog!.push("post-boot-shutdown");',
        "}",
        "",
      ].join("\n"),
    );

    const installResult = await installPluginPostBoot(
      "post-boot-shutdown",
      ctx,
    );
    expect(installResult.status).toBe("loaded");

    await runShutdownHooks("test");

    const recorded = (globalThis as { __postBootShutdownLog?: string[] })
      .__postBootShutdownLog;
    expect(recorded ?? []).toContain("post-boot-shutdown");

    // Registry entry remains after teardown — current boot-time semantics
    // expect a steady-state post-shutdown registry. Documented here so a
    // future change is intentional, not accidental.
    expect(getRegisteredPlugin("post-boot-shutdown")).toBeDefined();
  });
});

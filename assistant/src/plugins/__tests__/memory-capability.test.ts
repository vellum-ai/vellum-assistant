/**
 * Tests for the single-active-memory-plugin rule.
 *
 * An external plugin declaring `vellum.provides === "memory"` in its
 * `package.json` takes over the conversation's memory system: the built-in
 * memory plugins (`memory-retrieval`, `memory-v3-shadow`) yield, so their hooks
 * are filtered out at read time. Two simultaneously-active external memory
 * plugins is a misconfiguration rejected by `assertSingleMemoryPlugin`. With no
 * external memory plugin installed, the built-ins run exactly as before.
 *
 * Discovery is driven by the mtime cache (`scanPlugins`), which `getHooksFor`
 * refreshes via `getUserHooksFor`, so creating/removing plugin directories at
 * runtime is reflected on the next read — the same semantics as the `.disabled`
 * sentinel.
 *
 * The whole behavior is gated behind the `memory-plugin-provider` rollout flag.
 * With the flag off (the default), external memory plugins never override the
 * built-in — the built-in memory hooks stay active and no single-plugin
 * conflict is raised — regardless of what is installed. The yield/override cases
 * below seed the flag on via the override cache.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const TEST_WORKSPACE_DIR = join(
  tmpdir(),
  `vellum-memory-capability-test-${process.pid}-${Date.now()}`,
);
process.env.VELLUM_WORKSPACE_DIR = TEST_WORKSPACE_DIR;

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import { clearFeatureFlagOverridesCache } from "../../config/assistant-feature-flags.js";
import { getHooksFor, registerPluginHooks } from "../../hooks/registry.js";
import { assertSingleMemoryPlugin } from "../memory-capability.js";
import { resetPluginCacheForTests } from "../mtime-cache.js";
import { resetPluginRegistryForTests } from "../registry.js";

/**
 * Seed the `memory-plugin-provider` rollout flag on so external memory plugins
 * are permitted to override the built-in. Without this the flag resolves to its
 * registry default (off) and the built-in never yields.
 */
function enableMemoryPluginProviderFlag(): void {
  setOverridesForTesting({ "memory-plugin-provider": true });
}

/**
 * Create an external plugin directory with a `package.json`. When `provides` is
 * given, the manifest declares `vellum.provides`. A trivial `user-prompt-submit`
 * hook is written so the plugin contributes a hook of its own (proving the
 * external plugin drives injection).
 */
async function createExternalPlugin(
  name: string,
  opts: { provides?: "memory" } = {},
): Promise<void> {
  const dir = join(TEST_WORKSPACE_DIR, "plugins", name);
  await mkdir(join(dir, "hooks"), { recursive: true });
  const pkg: Record<string, unknown> = { name, version: "1.0.0" };
  if (opts.provides !== undefined) {
    pkg.vellum = { provides: opts.provides };
  }
  await writeFile(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  await writeFile(
    join(dir, "hooks", "user-prompt-submit.ts"),
    "export default async function () {}\n",
  );
}

/**
 * Register the two built-in memory plugins' `user-prompt-submit` hooks into the
 * in-process registry under their canonical names, mirroring what
 * `registerDefaultPlugins` does at boot. We register only the hook surface here
 * so the test exercises the read-time yield without booting the full default
 * set.
 */
function registerBuiltinMemoryHooks(): void {
  registerPluginHooks("memory-retrieval", {
    "user-prompt-submit": async () => {},
  });
  registerPluginHooks("memory-v3-shadow", {
    "user-prompt-submit": async () => {},
  });
}

beforeEach(() => {
  resetPluginRegistryForTests();
  resetPluginCacheForTests();
  clearFeatureFlagOverridesCache();
});

afterEach(async () => {
  await rm(join(TEST_WORKSPACE_DIR, "plugins"), {
    recursive: true,
    force: true,
  });
  resetPluginCacheForTests();
  resetPluginRegistryForTests();
  clearFeatureFlagOverridesCache();
});

describe("single-active-memory-plugin rule", () => {
  test("an enabled external memory plugin disables the built-in memory hooks", async () => {
    enableMemoryPluginProviderFlag();
    registerBuiltinMemoryHooks();

    // Baseline: with no external memory plugin, both built-in memory hooks run.
    let hooks = await getHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(2);

    // Install an external plugin that provides memory.
    await createExternalPlugin("external-memory", { provides: "memory" });

    // The external plugin's own hook is included, and BOTH built-in memory
    // hooks are filtered out — only the external memory hook remains.
    hooks = await getHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(1);
  });

  test("removing the external memory plugin restores the built-in memory hooks", async () => {
    enableMemoryPluginProviderFlag();
    registerBuiltinMemoryHooks();
    await createExternalPlugin("external-memory", { provides: "memory" });

    let hooks = await getHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(1);

    // Remove the external plugin — the built-ins stop yielding on the next read.
    await rm(join(TEST_WORKSPACE_DIR, "plugins", "external-memory"), {
      recursive: true,
      force: true,
    });

    hooks = await getHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(2);
  });

  test("a non-memory external plugin does not make the built-in yield", async () => {
    registerBuiltinMemoryHooks();

    // External plugin with no `provides` marker — its hook adds to the chain but
    // the built-in memory hooks stay active.
    await createExternalPlugin("regular-plugin");

    const hooks = await getHooksFor("user-prompt-submit");
    // 2 built-in memory hooks + 1 external plugin hook.
    expect(hooks).toHaveLength(3);
  });

  test("two active memory-capability plugins are rejected with a clear error", async () => {
    enableMemoryPluginProviderFlag();
    await createExternalPlugin("memory-a", { provides: "memory" });
    await createExternalPlugin("memory-b", { provides: "memory" });

    // Trigger a discovery scan so the mtime cache observes both plugins.
    await getHooksFor("user-prompt-submit");

    expect(() => assertSingleMemoryPlugin()).toThrow(
      /multiple memory-capability plugins are active/,
    );
    // The error names both offenders so an operator can disable one.
    expect(() => assertSingleMemoryPlugin()).toThrow(/memory-a/);
    expect(() => assertSingleMemoryPlugin()).toThrow(/memory-b/);
  });

  test("two active memory plugins fail safe: the built-in stays active", async () => {
    enableMemoryPluginProviderFlag();
    registerBuiltinMemoryHooks();
    await createExternalPlugin("memory-a", { provides: "memory" });
    await createExternalPlugin("memory-b", { provides: "memory" });

    // With two external memory plugins, the built-in does NOT yield (fail safe).
    // Hooks: 2 built-in memory + 2 external plugin hooks.
    const hooks = await getHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(4);
  });

  test("no external memory plugin: assertSingleMemoryPlugin does not throw", async () => {
    await getHooksFor("user-prompt-submit");
    expect(() => assertSingleMemoryPlugin()).not.toThrow();
  });
});

describe("memory-plugin-provider rollout flag gate", () => {
  test("flag off (default): an external memory plugin does NOT override the built-in", async () => {
    // No flag seeded — resolves to the registry default (off).
    registerBuiltinMemoryHooks();
    await createExternalPlugin("external-memory", { provides: "memory" });

    // The external plugin's own hook still loads, but the built-in memory hooks
    // are NOT filtered out: 2 built-in + 1 external = 3.
    const hooks = await getHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(3);

    // No single-plugin conflict is raised while the flag is off, even with two
    // external memory plugins present.
    await createExternalPlugin("external-memory-2", { provides: "memory" });
    await getHooksFor("user-prompt-submit");
    expect(() => assertSingleMemoryPlugin()).not.toThrow();
  });

  test("flag on: an external memory plugin overrides the built-in", async () => {
    enableMemoryPluginProviderFlag();
    registerBuiltinMemoryHooks();
    await createExternalPlugin("external-memory", { provides: "memory" });

    // Built-in memory hooks yield; only the external memory hook remains.
    const hooks = await getHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(1);
  });
});

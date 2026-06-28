/**
 * Tests for the single-active-memory-plugin rule.
 *
 * An external plugin declaring `vellum.provides === "memory"` in its
 * `package.json` takes over the conversation's memory system. The yield is
 * MEMORY-SPECIFIC: only the PURE-memory built-in (`memory-v3-shadow`) has its
 * hooks filtered out wholesale at read time. `memory-retrieval` keeps running —
 * it also drives general runtime assembly (the non-memory `<turn_context>` /
 * workspace / PKB / NOW / channel blocks), and suppresses only its memory
 * portion downstream — so its `user-prompt-submit` hook survives. Two
 * simultaneously-active external memory plugins is a misconfiguration rejected
 * by `assertSingleMemoryPlugin`. With no external memory plugin installed, both
 * built-ins run exactly as before.
 *
 * Discovery is driven by the mtime cache (`scanPlugins`), which `getHooksFor`
 * refreshes via `getUserHooksFor`, so creating/removing plugin directories at
 * runtime is reflected on the next read — the same semantics as the `.disabled`
 * sentinel.
 *
 * The whole behavior is gated behind the `memory-plugin-provider` rollout flag.
 * With the flag off (the default), external memory plugins never override the
 * built-in — both built-in memory hooks stay active and no single-plugin
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

/** Built-in hook names recorded when an invoked hook runs (see below). */
const firedBuiltinHooks: string[] = [];

/**
 * Register the two built-in memory plugins' `user-prompt-submit` hooks into the
 * in-process registry under their canonical names, mirroring what
 * `registerDefaultPlugins` does at boot. Each built-in hook records its plugin
 * name into {@link firedBuiltinHooks} when invoked, so a test can assert WHICH
 * built-in hooks survived the yield (not just the count). We register only the
 * hook surface here so the test exercises the read-time yield without booting
 * the full default set.
 */
function registerBuiltinMemoryHooks(): void {
  registerPluginHooks("memory-retrieval", {
    "user-prompt-submit": async () => {
      firedBuiltinHooks.push("memory-retrieval");
    },
  });
  registerPluginHooks("memory-v3-shadow", {
    "user-prompt-submit": async () => {
      firedBuiltinHooks.push("memory-v3-shadow");
    },
  });
}

/**
 * Run every hook `getHooksFor` returns for `user-prompt-submit` and return the
 * set of BUILT-IN plugin names that fired (external plugins' anonymous hooks
 * contribute no name). Lets a test distinguish "`memory-v3-shadow` yielded but
 * `memory-retrieval` survived" from a bare count.
 */
async function firedBuiltinMemoryHooks(): Promise<string[]> {
  firedBuiltinHooks.length = 0;
  const hooks = await getHooksFor("user-prompt-submit");
  for (const hook of hooks) {
    await hook(undefined as never);
  }
  return [...firedBuiltinHooks];
}

beforeEach(() => {
  resetPluginRegistryForTests();
  resetPluginCacheForTests();
  clearFeatureFlagOverridesCache();
  firedBuiltinHooks.length = 0;
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
  test("an enabled external memory plugin drops only the pure-memory built-in hook", async () => {
    enableMemoryPluginProviderFlag();
    registerBuiltinMemoryHooks();

    // Baseline: with no external memory plugin, both built-in memory hooks run.
    expect(await firedBuiltinMemoryHooks()).toEqual([
      "memory-retrieval",
      "memory-v3-shadow",
    ]);

    // Install an external plugin that provides memory.
    await createExternalPlugin("external-memory", { provides: "memory" });

    // The external plugin's own hook is included (3 total), but only the
    // PURE-memory built-in (`memory-v3-shadow`) is filtered out —
    // `memory-retrieval` KEEPS running because it also drives non-memory
    // runtime assembly, so it must keep emitting the non-memory blocks.
    const hooks = await getHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(2);
    expect(await firedBuiltinMemoryHooks()).toEqual(["memory-retrieval"]);
  });

  test("removing the external memory plugin restores the pure-memory built-in hook", async () => {
    enableMemoryPluginProviderFlag();
    registerBuiltinMemoryHooks();
    await createExternalPlugin("external-memory", { provides: "memory" });

    // Active: `memory-v3-shadow` yields; `memory-retrieval` survives.
    expect(await firedBuiltinMemoryHooks()).toEqual(["memory-retrieval"]);

    // Remove the external plugin — the pure-memory built-in stops yielding on
    // the next read, so both built-in memory hooks run again.
    await rm(join(TEST_WORKSPACE_DIR, "plugins", "external-memory"), {
      recursive: true,
      force: true,
    });

    expect(await firedBuiltinMemoryHooks()).toEqual([
      "memory-retrieval",
      "memory-v3-shadow",
    ]);
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

  test("flag on: an external memory plugin overrides the pure-memory built-in", async () => {
    enableMemoryPluginProviderFlag();
    registerBuiltinMemoryHooks();
    await createExternalPlugin("external-memory", { provides: "memory" });

    // The pure-memory built-in (`memory-v3-shadow`) yields; `memory-retrieval`
    // survives (it drives non-memory runtime assembly). 2 remain:
    // `memory-retrieval` + the external memory hook.
    const hooks = await getHooksFor("user-prompt-submit");
    expect(hooks).toHaveLength(2);
    expect(await firedBuiltinMemoryHooks()).toEqual(["memory-retrieval"]);
  });
});

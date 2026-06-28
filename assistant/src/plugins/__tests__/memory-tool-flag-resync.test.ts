/**
 * Runtime resync of the built-in `remember`/`recall` TOOLS on a
 * `memory-plugin-provider` flag flip — the tool-side companion to the hook-side
 * yield the memory-capability test covers.
 *
 * The built-in memory hooks already yield at read time when an external memory
 * plugin is active AND the flag is on (`shouldBuiltinMemoryYield`). The built-in
 * core tools, however, are registered once at boot — so without a resync, a
 * runtime flag flip would leave the built-in hooks yielding while the built-in
 * core tools stay registered, splitting hook and tool ownership until a restart.
 *
 * `scanPlugins` (driven here via `getHooksFor` → `getUserHooksFor`) reconciles
 * the built-in tools whenever the yield decision flips — including a flag flip
 * with no plugin-set change. This test installs a memory plugin while the flag
 * is off, then flips the flag and rescans:
 *
 * - flag off  → the memory plugin's hooks do NOT yet suppress the built-in, and
 *   the built-in `remember`/`recall` tools stay registered.
 * - flag on   → the built-in should yield; the resync strips the built-in core
 *   tools so the plugin's same-named tools can register cleanly.
 * - flag off again → the resync restores the built-in tools.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

const TEST_WORKSPACE_DIR = join(
  tmpdir(),
  `vellum-memory-tool-resync-test-${process.pid}-${Date.now()}`,
);
process.env.VELLUM_WORKSPACE_DIR = TEST_WORKSPACE_DIR;

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import { clearFeatureFlagOverridesCache } from "../../config/assistant-feature-flags.js";
import * as configLoader from "../../config/loader.js";
import { AssistantConfigSchema } from "../../config/schema.js";
import { getHooksFor } from "../../hooks/registry.js";
import { reconcileBuiltinMemoryTools } from "../../tools/memory/builtin-memory-tool-sync.js";
import { __clearRegistryForTesting, getTool } from "../../tools/registry.js";
import { resetPluginCacheForTests } from "../mtime-cache.js";

/** Pin the active provider to v2 so the built-in memory tools are a known pair. */
function pinV2Config(): void {
  spyOn(configLoader, "getConfig").mockReturnValue(
    AssistantConfigSchema.parse({ memory: { provider: "v2" } }),
  );
  spyOn(configLoader, "getConfigReadOnly").mockReturnValue(
    AssistantConfigSchema.parse({ memory: { provider: "v2" } }),
  );
}

/** Install/remove the `memory-plugin-provider` rollout flag override. */
function setProviderFlag(on: boolean): void {
  setOverridesForTesting({ "memory-plugin-provider": on });
}

/** Create an external plugin directory that declares `provides: "memory"`. */
async function createMemoryPlugin(name: string): Promise<void> {
  const dir = join(TEST_WORKSPACE_DIR, "plugins", name);
  await mkdir(join(dir, "hooks"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", vellum: { provides: "memory" } }),
  );
  await writeFile(
    join(dir, "hooks", "user-prompt-submit.ts"),
    "export default async function () {}\n",
  );
}

beforeEach(() => {
  __clearRegistryForTesting();
  resetPluginCacheForTests();
  clearFeatureFlagOverridesCache();
  pinV2Config();
});

afterEach(async () => {
  await rm(join(TEST_WORKSPACE_DIR, "plugins"), {
    recursive: true,
    force: true,
  });
  __clearRegistryForTesting();
  resetPluginCacheForTests();
  clearFeatureFlagOverridesCache();
  spyOn(configLoader, "getConfig").mockRestore();
  spyOn(configLoader, "getConfigReadOnly").mockRestore();
});

describe("memory tool resync on memory-plugin-provider flag flip", () => {
  test("flipping the flag at runtime reconciles the built-in memory tools", async () => {
    // The built-in memory tools start registered, as `initializeTools()` would
    // leave them while the flag is off (built-in not yielding).
    reconcileBuiltinMemoryTools();
    expect(getTool("remember")).toBeDefined();
    expect(getTool("recall")).toBeDefined();

    // A memory plugin is installed, but the flag is still OFF — the built-in
    // does not yield, so a scan leaves the built-in tools in place.
    setProviderFlag(false);
    await createMemoryPlugin("external-memory");
    await getHooksFor("user-prompt-submit");
    expect(getTool("remember")).toBeDefined();
    expect(getTool("recall")).toBeDefined();

    // Flip the flag ON at runtime (no plugin-set change). The next scan observes
    // the yield decision flip and strips the built-in core tools.
    setProviderFlag(true);
    await getHooksFor("user-prompt-submit");
    expect(getTool("remember")).toBeUndefined();
    expect(getTool("recall")).toBeUndefined();

    // Flip the flag OFF again — the built-in stops yielding and the tools are
    // restored, all without a restart.
    setProviderFlag(false);
    await getHooksFor("user-prompt-submit");
    expect(getTool("remember")).toBeDefined();
    expect(getTool("recall")).toBeDefined();
  });

  test("a re-scan while yielding does not strip the external plugin's tool", async () => {
    // Reach the steady state where a memory plugin has taken over: with the flag
    // ON the built-in yields, so the plugin can register and OWN `remember`.
    setProviderFlag(true);
    await createMemoryPlugin("external-memory");
    await getHooksFor("user-prompt-submit");

    const { RiskLevel } = await import("../../permissions/types.js");
    const { registerPluginTools, getToolOwner } =
      await import("../../tools/registry.js");
    registerPluginTools("external-memory", [
      {
        name: "remember",
        description: "plugin remember",
        category: "plugin",
        defaultRiskLevel: RiskLevel.Low,
        executionTarget: "sandbox",
        input_schema: { type: "object", properties: {} },
        execute: async () => ({ content: "", isError: false }),
      },
    ]);
    expect(getToolOwner("remember")).toEqual({
      kind: "plugin",
      id: "external-memory",
    });

    // A further scan (still yielding) must leave the plugin-owned tool intact —
    // the resync only evicts unowned core tools, never a plugin's own.
    await getHooksFor("user-prompt-submit");

    expect(getTool("remember")).toBeDefined();
    expect(getToolOwner("remember")).toEqual({
      kind: "plugin",
      id: "external-memory",
    });
  });
});

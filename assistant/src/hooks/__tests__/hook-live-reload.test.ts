/**
 * Pins the eviction primitives hook live-reload is built on, driven through
 * the production import machinery (`preImportHooksDir` →
 * `collectUserHookEntries`), one layer below the sentinel-driven reconcile
 * that orchestrates them in production (see `../../plugins/mtime-cache.ts`
 * and its end-to-end suite).
 *
 * Two invariants live here:
 *
 * 1. **The Bun primitive.** Deleting a file's `require.cache` entry makes
 *    the next dynamic `import()` re-evaluate it from disk. This is
 *    Node-compat surface, intended per
 *    github.com/oven-sh/bun/discussions/10162 but not spec-guaranteed — a
 *    Bun upgrade that breaks it must fail here rather than silently degrade
 *    hook edits back to restart-required.
 *
 * 2. **Whole-owner eviction.** Evicting only a hook's own module re-binds
 *    the re-imported hook to its stale cached helpers. The reconcile sweeps
 *    every path in the plugin for exactly this reason, and this suite pins
 *    the failure mode that rule prevents.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { evictModule } from "../../plugins/surface-import.js";
import type { HookEntry } from "../../plugins/types.js";
import {
  collectUserHookEntries,
  evictHooksForOwner,
  preImportHooksDir,
  resetHookCacheForTests,
} from "../hook-loader.js";

const HOOK_NAME = "user-prompt-submit";

const root = mkdtempSync(join(tmpdir(), "hook-live-reload-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  resetHookCacheForTests();
});

/** Fresh plugin fixture: `<root>/<name>/hooks/`, unique name per call. */
let pluginSeq = 0;
function makePlugin(): { dir: string; hooksDir: string; name: string } {
  const name = `reload-plugin-${++pluginSeq}`;
  const dir = join(root, name);
  const hooksDir = join(dir, "hooks");
  mkdirSync(join(dir, "lib"), { recursive: true });
  mkdirSync(hooksDir, { recursive: true });
  return { dir, hooksDir, name };
}

/**
 * Redeploy an owner's hooks the way the reconcile does: drop its cache
 * entries, sweep the given module paths, and re-import from disk.
 */
async function redeploy(
  plugin: { hooksDir: string; name: string },
  modulePaths: string[],
): Promise<void> {
  evictHooksForOwner(plugin.name);
  for (const path of modulePaths) {
    evictModule(path);
  }
  await preImportHooksDir(plugin.hooksDir, plugin.name);
}

/** Collect and run the single expected hook, returning its result. */
async function dispatchOne(plugin: {
  dir: string;
  name: string;
}): Promise<unknown> {
  const entries: HookEntry[] = await collectUserHookEntries(HOOK_NAME, [
    [plugin.dir, plugin.name],
  ]);
  expect(entries).toHaveLength(1);
  return (entries[0]!.fn as () => unknown)();
}

describe("hook reload primitives", () => {
  test("evict + re-import serves fresh hook code, repeatably", async () => {
    const plugin = makePlugin();
    const hookPath = join(plugin.hooksDir, `${HOOK_NAME}.ts`);
    writeFileSync(hookPath, `export default () => "v1";\n`);
    await preImportHooksDir(plugin.hooksDir, plugin.name);
    expect(await dispatchOne(plugin)).toBe("v1");

    // Two edit → redeploy cycles: the first proves the primitive, the
    // second proves a re-imported module is itself evictable again.
    for (const marker of ["v2", "v3"]) {
      writeFileSync(
        hookPath,
        `export default () => ${JSON.stringify(marker)};\n`,
      );
      await redeploy(plugin, [hookPath]);
      expect(await dispatchOne(plugin)).toBe(marker);
    }
  });

  test("dispatch serves the same cached function until an eviction", async () => {
    const plugin = makePlugin();
    writeFileSync(
      join(plugin.hooksDir, `${HOOK_NAME}.ts`),
      `export default () => "stable";\n`,
    );
    await preImportHooksDir(plugin.hooksDir, plugin.name);

    const first = await collectUserHookEntries(HOOK_NAME, [
      [plugin.dir, plugin.name],
    ]);
    const second = await collectUserHookEntries(HOOK_NAME, [
      [plugin.dir, plugin.name],
    ]);

    // Same function instance: dispatch is a map lookup, not an import.
    expect(second[0]!.fn).toBe(first[0]!.fn);
  });

  test("evicting only the hook re-binds it to a stale helper; the full sweep does not", async () => {
    const plugin = makePlugin();
    const helperPath = join(plugin.dir, "lib", "helper.ts");
    const hookPath = join(plugin.hooksDir, `${HOOK_NAME}.ts`);
    writeFileSync(helperPath, `export const value = "h1";\n`);
    writeFileSync(
      hookPath,
      `import { value } from "../lib/helper.ts";\nexport default () => value;\n`,
    );
    await preImportHooksDir(plugin.hooksDir, plugin.name);
    expect(await dispatchOne(plugin)).toBe("h1");

    writeFileSync(helperPath, `export const value = "h2";\n`);

    // Partial eviction — the hook file only. The re-evaluated hook binds to
    // the helper module still cached at h1: the version-skew failure mode
    // whole-plugin sweeping exists to prevent.
    await redeploy(plugin, [hookPath]);
    expect(await dispatchOne(plugin)).toBe("h1");

    // The full sweep (hook + helper, as the reconcile's eviction list would
    // carry) brings the edit through.
    await redeploy(plugin, [hookPath, helperPath]);
    expect(await dispatchOne(plugin)).toBe("h2");
  });

  test("re-import after owner eviction drops hooks whose files are gone", async () => {
    const plugin = makePlugin();
    const hookPath = join(plugin.hooksDir, `${HOOK_NAME}.ts`);
    writeFileSync(hookPath, `export default () => "here";\n`);
    await preImportHooksDir(plugin.hooksDir, plugin.name);
    expect(await dispatchOne(plugin)).toBe("here");

    rmSync(hookPath);
    await redeploy(plugin, [hookPath]);

    const entries = await collectUserHookEntries(HOOK_NAME, [
      [plugin.dir, plugin.name],
    ]);
    expect(entries).toHaveLength(0);
  });
});

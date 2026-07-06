/**
 * End-to-end coverage for hook live-reload through the hook loader: an
 * edited hook file takes effect on the next dispatch, without a daemon
 * restart.
 *
 * The loader keys each hook on its source file's mtime; when the mtime
 * moves it evicts the module from the runtime registry (`evictModule` in
 * `../../plugins/surface-import.ts`) and re-imports, so the fresh content is
 * what dispatches. These tests drive the public collection API against real
 * hook files on disk, which also makes them the regression guard for the
 * Bun behavior the eviction is built on — `require.cache` deletion
 * invalidating dynamic `import()` is intended per
 * github.com/oven-sh/bun/discussions/10162 but not spec-guaranteed, and a
 * Bun upgrade that breaks it must fail here rather than silently degrade
 * hook edits back to restart-required.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import type { HookEntry } from "../../plugins/types.js";
import { getWorkspaceHooksDir } from "../../util/platform.js";
import {
  collectUserHookEntries,
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

/**
 * Each write gets an explicitly bumped, strictly increasing mtime: two
 * writes can land inside the same filesystem-timestamp granule, which the
 * loader's mtime check would read as "unchanged". Real edits arrive seconds
 * apart; the tests must not race that granularity.
 */
let mtimeSeq = 1_750_000_000;
function writeHookFile(hooksDir: string, marker: string): string {
  const path = join(hooksDir, `${HOOK_NAME}.ts`);
  writeFileSync(path, `export default () => ${JSON.stringify(marker)};\n`);
  const stamp = new Date(++mtimeSeq * 1000);
  utimesSync(path, stamp, stamp);
  return path;
}

/** Fresh plugin fixture: `<root>/<name>/hooks/`, unique name per call. */
let pluginSeq = 0;
function makePlugin(): { dir: string; hooksDir: string; name: string } {
  const name = `reload-plugin-${++pluginSeq}`;
  const dir = join(root, name);
  const hooksDir = join(dir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  return { dir, hooksDir, name };
}

/** Collect the hook chain for a plugin, exactly as dispatch does. */
async function collect(
  pluginDir: string,
  pluginName: string,
): Promise<HookEntry[]> {
  return collectUserHookEntries(HOOK_NAME, [[pluginDir, pluginName]]);
}

/** Run the single expected hook in the chain and return its result. */
async function dispatchOne(
  pluginDir: string,
  pluginName: string,
): Promise<unknown> {
  const entries = await collect(pluginDir, pluginName);
  expect(entries).toHaveLength(1);
  return (entries[0]!.fn as () => unknown)();
}

describe("hook live-reload", () => {
  test("an edited hook file takes effect on the next dispatch, repeatably", async () => {
    const plugin = makePlugin();
    writeHookFile(plugin.hooksDir, "v1");
    expect(await dispatchOne(plugin.dir, plugin.name)).toBe("v1");

    // Two edit → dispatch cycles: the first proves reload works at all, the
    // second proves a reloaded hook is itself reloadable (edits keep landing
    // turn after turn, not just once).
    for (const marker of ["v2", "v3"]) {
      writeHookFile(plugin.hooksDir, marker);
      expect(await dispatchOne(plugin.dir, plugin.name)).toBe(marker);
    }
  });

  test("an unchanged hook file is served from the cache, not re-imported", async () => {
    const plugin = makePlugin();
    writeHookFile(plugin.hooksDir, "stable");

    const first = await collect(plugin.dir, plugin.name);
    const second = await collect(plugin.dir, plugin.name);

    // Same function instance means the cache hit — dispatch after dispatch
    // costs a stat, not an import.
    expect(second[0]!.fn).toBe(first[0]!.fn);
  });

  test("a deleted hook stops dispatching; recreating it serves the new content", async () => {
    const plugin = makePlugin();
    const path = writeHookFile(plugin.hooksDir, "original");
    expect(await dispatchOne(plugin.dir, plugin.name)).toBe("original");

    unlinkSync(path);
    expect(await collect(plugin.dir, plugin.name)).toHaveLength(0);

    // The recreated file must dispatch its own content, not the module the
    // registry cached for the deleted original.
    writeHookFile(plugin.hooksDir, "recreated");
    expect(await dispatchOne(plugin.dir, plugin.name)).toBe("recreated");
  });

  test("standalone workspace hooks reload the same way", async () => {
    const wsHooksDir = getWorkspaceHooksDir();
    mkdirSync(wsHooksDir, { recursive: true });
    const path = writeHookFile(wsHooksDir, "ws-v1");

    try {
      const before = await collectUserHookEntries(HOOK_NAME, []);
      expect(before).toHaveLength(1);
      expect(before[0]!.owner.kind).toBe("workspace");
      expect((before[0]!.fn as () => unknown)()).toBe("ws-v1");

      writeHookFile(wsHooksDir, "ws-v2");
      const after = await collectUserHookEntries(HOOK_NAME, []);
      expect((after[0]!.fn as () => unknown)()).toBe("ws-v2");
    } finally {
      // The workspace hooks dir is shared per-process test state — leave it
      // the way this test found it.
      unlinkSync(path);
    }
  });
});

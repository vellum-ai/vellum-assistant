/**
 * Regression guard for the Bun module-cache behavior that hook live-reload
 * depends on.
 *
 * User-land hooks and plugin tools are plain files loaded with dynamic
 * `import()` (see `../surface-import.ts`). Bun caches those imports by
 * resolved path and exposes no ESM-side invalidation API — but deleting the
 * file's entry from `require.cache` invalidates Bun's shared CJS/ESM module
 * registry, so the next `import()` of the same path re-evaluates the file
 * from disk. Reloading an edited hook without a daemon restart is built on
 * exactly that primitive: evict, then re-import.
 *
 * The primitive is Node-compat surface, confirmed intended by Bun
 * maintainers (github.com/oven-sh/bun/discussions/10162) but not
 * spec-guaranteed, so this suite pins it. If a Bun upgrade breaks any
 * assertion here, hook reload silently degrades to restart-required — and
 * this test is the only thing that will say so.
 *
 * Deliberately src-free: the invariant belongs to the runtime, not to any
 * module of ours, so it must keep failing loudly even if the loaders above
 * it are refactored away.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

const dir = mkdtempSync(join(tmpdir(), "module-cache-invariant-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Write a hook-shaped module (TS, default-export function) whose return
 * value identifies the version of the file that was evaluated.
 */
function writeHookFile(path: string, marker: string): void {
  writeFileSync(path, `export default () => ${JSON.stringify(marker)};\n`);
}

describe("Bun module cache invalidation invariant", () => {
  test("dynamic import() caches by resolved path — a content edit alone is not observed", async () => {
    const modPath = join(dir, "stale-baseline.ts");
    writeHookFile(modPath, "v1");
    const first = (await import(modPath)).default();
    writeHookFile(modPath, "v2");
    const second = (await import(modPath)).default();

    // This staleness is WHY the eviction step exists. If Bun ever starts
    // invalidating on its own (e.g. by mtime), eviction becomes redundant
    // and this test should be revisited alongside the reload path.
    expect(first).toBe("v1");
    expect(second).toBe("v1");
  });

  test("delete require.cache[path] makes the next import() re-evaluate the file — repeatably", async () => {
    const modPath = join(dir, "evict-reload.ts");
    writeHookFile(modPath, "v1");
    expect((await import(modPath)).default()).toBe("v1");

    // Two full edit → evict → re-import cycles: the first proves the
    // primitive, the second proves the refreshed entry is itself evictable
    // (i.e. reload keeps working turn after turn, not just once).
    for (const marker of ["v2", "v3"]) {
      writeHookFile(modPath, marker);
      delete require.cache[modPath];
      expect((await import(modPath)).default()).toBe(marker);
    }
  });

  test("eviction is per-file — an evicted module re-binds to still-cached imports", async () => {
    const helperPath = join(dir, "dep-helper.ts");
    const hookPath = join(dir, "dep-hook.ts");
    writeFileSync(helperPath, `export const helperVersion = "h1";\n`);
    writeFileSync(
      hookPath,
      `import { helperVersion } from "./dep-helper.ts";\n` +
        `export default () => helperVersion;\n`,
    );
    expect((await import(hookPath)).default()).toBe("h1");

    // Edit the helper but evict only the hook: the re-evaluated hook must
    // still see the cached helper. Reload code therefore has to evict every
    // file it wants refreshed (e.g. all entries under a plugin dir), not
    // just the entry-point hook.
    writeFileSync(helperPath, `export const helperVersion = "h2";\n`);
    delete require.cache[hookPath];
    expect((await import(hookPath)).default()).toBe("h1");

    // Evicting the helper as well brings the edit through.
    delete require.cache[helperPath];
    delete require.cache[hookPath];
    expect((await import(hookPath)).default()).toBe("h2");
  });

  test("re-evaluation re-runs the module's top-level code", async () => {
    const modPath = join(dir, "side-effect.ts");
    const slot = "__moduleCacheInvariantEvalCount";
    writeFileSync(
      modPath,
      `(globalThis as any)[${JSON.stringify(slot)}] =\n` +
        `  ((globalThis as any)[${JSON.stringify(slot)}] ?? 0) + 1;\n` +
        `export default () => (globalThis as any)[${JSON.stringify(slot)}];\n`,
    );

    await import(modPath);
    delete require.cache[modPath];
    await import(modPath);

    // Two evictions → two evaluations. This is the sharp edge reload code
    // must own: a hook's top-level side effects (timers, listeners) run
    // again on every reload and the old instance is never torn down, so a
    // reload must be shutdown → evict → import → init, not a bare re-import.
    expect((await import(modPath)).default()).toBe(2);
    delete (globalThis as Record<string, unknown>)[slot];
  });
});

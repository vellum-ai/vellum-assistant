/**
 * Hard guard: refuse to resolve a DB path to the canonical live production
 * database from a Bun test runner.
 *
 * Context
 * -------
 * Six prior incidents (Apr 6 credential store, Apr 11 contacts, Apr 14
 * contacts, May 22 / May 24 / May 25 DB ghosts) share the same root cause:
 * the test preload at `assistant/src/__tests__/test-preload.ts` is supposed
 * to override `VELLUM_WORKSPACE_DIR` to a temporary directory before any
 * test code runs. When the preload silently fails to load — e.g. because a
 * transitively-imported file's `node_modules` resolution breaks — the
 * daemon's `VELLUM_WORKSPACE_DIR=/workspace` stays in effect, and any
 * destructive test setup (`rmSync(getDbPath())`, `DELETE FROM <table>`)
 * targets the live database. See
 * `/workspace/journal/2026-05-25-db-ghost-3-recovery.md` for full forensics.
 *
 * This guard fires at the moment of access: every call to `getDbPath()`
 * runs through `assertNotLiveDbInTests`, which throws if the test-runner
 * heuristic matches AND the resolved path equals the canonical sandbox
 * live DB path.
 *
 * Why not env vars
 * ----------------
 * We can't gate on `process.env.BUN_TEST === "1"` for two reasons:
 *   1. Verified May 26, 2026 — Bun does NOT auto-set `BUN_TEST`. The
 *      existing checks in `plugins/registry.ts`, `util/logger.ts`, etc.
 *      are inert unless something else sets it.
 *   2. The migration tests at `__tests__/db-*-migration.test.ts`
 *      deliberately set `process.env.BUN_TEST = "0"` in `beforeEach` to
 *      bypass test-mode gates in `db-init.ts`. Env-based detection is
 *      defeatable.
 *
 * We can't gate on `VELLUM_ALLOW_LIVE_DB` (or any daemon-set sentinel)
 * because env vars set by the daemon are inherited by every subprocess —
 * including the bash tool's `bun test` invocation. The guard would never
 * fire.
 *
 * Detection via `Bun.main`
 * ------------------------
 * `Bun.main` is the entry file Bun was invoked with. Verified by probing
 * on May 26, 2026:
 *   - `bun test foo.test.ts` → `Bun.main` = `foo.test.ts`
 *   - `bun test path/to/dir/` → `Bun.main` rotates per-file as each test
 *     file runs (each test file sees its own `Bun.main`).
 *   - The daemon's `Bun.main` is its compiled entry point, never a
 *     test-shaped path.
 *
 * The runtime state of `Bun.main` cannot be forged by inherited env vars
 * or by a migration test setting `BUN_TEST = "0"`.
 */

/**
 * The canonical sandbox path of the live production daemon's SQLite
 * database. Hardcoded — this is the exact path `getDbPath()` resolves to
 * when `VELLUM_WORKSPACE_DIR=/workspace` (the daemon's inherited env on
 * the EC2 Mac sandbox).
 *
 * NOTE: dev-machine paths (`~/.vellum/workspace/data/db/assistant.db`)
 * are intentionally NOT covered by this guard. The hazard exists there
 * too in principle, but the primary blast radius is the sandbox daemon,
 * and `homedir()` varies by CI runner / user.
 */
export const LIVE_DB_PATH_SANDBOX = "/workspace/data/db/assistant.db";

/**
 * Returns true if this process is running under `bun test`.
 *
 * Heuristic: `Bun.main` is set to the test file Bun is currently running.
 * Anything ending in `.test.ts` / `.test.tsx` / `.test.js`, or anything
 * under a `__tests__/` directory, counts.
 *
 * Returns false outside a Bun runtime (e.g. node-based scripts) and
 * inside the production daemon (whose `Bun.main` is its compiled entry
 * point).
 */
export function isBunTestRunner(): boolean {
  if (typeof Bun === "undefined") return false;
  const main = Bun.main;
  if (!main) return false;
  return (
    main.endsWith(".test.ts") ||
    main.endsWith(".test.tsx") ||
    main.endsWith(".test.js") ||
    main.includes("/__tests__/")
  );
}

/**
 * Throws if the resolved DB path is the canonical live production DB AND
 * the current process is a Bun test runner. No-op otherwise.
 *
 * Called from `getDbPath()` so every code path that resolves the DB
 * location is protected — including the destructive `rmSync(dbPath)`
 * calls in migration test setup.
 */
export function assertNotLiveDbInTests(resolvedPath: string): void {
  if (!isBunTestRunner()) return;
  if (resolvedPath !== LIVE_DB_PATH_SANDBOX) return;
  throw new Error(
    `Refusing to resolve getDbPath() to the live production DB ` +
      `(${LIVE_DB_PATH_SANDBOX}) from a Bun test runner.\n` +
      `\n` +
      `VELLUM_WORKSPACE_DIR=${process.env.VELLUM_WORKSPACE_DIR ?? "<unset>"}\n` +
      `Bun.main=${typeof Bun !== "undefined" ? Bun.main : "<no Bun>"}\n` +
      `\n` +
      `The test preload (assistant/src/__tests__/test-preload.ts) is ` +
      `supposed to override VELLUM_WORKSPACE_DIR to a temporary directory ` +
      `before this call. If you are seeing this error, the preload either ` +
      `did not run or was bypassed — most likely because a transitively ` +
      `imported file failed to resolve (e.g. broken node_modules symlink ` +
      `in a worktree).\n` +
      `\n` +
      `See /workspace/journal/2026-05-25-db-ghost-3-recovery.md for the ` +
      `incident this guard prevents.`,
  );
}

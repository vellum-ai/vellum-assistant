/**
 * Shared helper for locating a `sqlite3` CLI binary on the host.
 *
 * Used by `memory/db-async-query.ts` so slow statements (`VACUUM`,
 * `PRAGMA optimize`, large bulk deletes) can be shelled out to a
 * subprocess and run without blocking the daemon's main event loop.
 *
 * Resolution order (matches the spirit of `bun-runtime.ts#findBun()`):
 *   1. Common system install locations
 *   2. `Bun.which("sqlite3")` (PATH lookup)
 *
 * Unlike `bun-runtime.ts`, this module does **not** download `sqlite3`
 * when missing. The async path is opt-out (callers fall back to the
 * synchronous in-process `bun:sqlite` connection); if a user wants the
 * non-blocking behavior they install one package.
 *
 * On platform (k8s assistant container) `sqlite3` is installed in the
 * Dockerfile, so the primary path is always available there. On macOS
 * `sqlite3` ships with the OS. On most Linux distros it's available via
 * the system package manager.
 */

import { existsSync } from "node:fs";

let cachedSqlite3Path: string | undefined | null;

/**
 * Synchronous lookup for a usable `sqlite3` CLI binary.
 * Returns the path if found, `undefined` otherwise. Result is cached
 * per-process so the filesystem checks only happen once.
 */
export function findSqlite3(): string | undefined {
  if (cachedSqlite3Path !== undefined) {
    return cachedSqlite3Path ?? undefined;
  }

  // 1. Common install locations. We check these before `Bun.which` so we
  //    pick a deterministic, predictable binary even when PATH is
  //    unusual (e.g. a daemon launched with a stripped env).
  for (const p of [
    "/usr/bin/sqlite3",
    "/usr/local/bin/sqlite3",
    "/opt/homebrew/bin/sqlite3",
  ]) {
    if (existsSync(p)) {
      cachedSqlite3Path = p;
      return p;
    }
  }

  // 2. PATH lookup.
  const which = Bun.which("sqlite3");
  if (which) {
    cachedSqlite3Path = which;
    return which;
  }

  cachedSqlite3Path = null;
  return undefined;
}

/** Reset the cached lookup. Test-only. */
export function _resetSqlite3Cache(): void {
  cachedSqlite3Path = undefined;
}

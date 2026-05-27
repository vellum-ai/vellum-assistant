/**
 * Test-only utilities for safely interacting with on-disk DB files.
 *
 * Two exports:
 *
 * - `assertNotLiveDb(dbPath)` — per-callsite guard. Throws unless the
 *   path resolves under `os.tmpdir()`. Use it before any custom
 *   destructive operation not covered by `removeTestDbFiles`.
 * - `removeTestDbFiles(dbPath)` — guarded `rmSync` of the DB file and
 *   its sibling `-shm` / `-wal` files. The standard way to clear a
 *   test DB between migrations.
 *
 * Defence-in-depth complement to the test-preload-verifier
 * (`os.tmpdir()` containment check during preload). If a future bug
 * lets a test see a non-tmpdir path despite the preload guard, every
 * destructive call still has its own line of defence.
 *
 * Positive assertion: the path MUST resolve under `os.tmpdir()`. Same
 * shape as the preload verifier — no enumeration of "real" paths,
 * works across every deployment.
 *
 * No source-module imports — only node stdlib. Helpers in `__tests__/`
 * must not import from `src/` (see assistant/AGENTS.md). Callers pass
 * the resolved `dbPath` in so this file stays decoupled from
 * `src/util/platform.ts`.
 */

import { realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, sep } from "node:path";

function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // realpathSync throws if the path doesn't exist. Fall back to the
    // parent directory — which must exist for any rmSync target that's
    // about to be touched. Returning the parent path here lets the
    // containment check succeed in the common "file already deleted"
    // case (rmSync with `force: true`) without falsely failing.
    try {
      return realpathSync(dirname(p));
    } catch {
      return p;
    }
  }
}

export function assertNotLiveDb(dbPath: string): void {
  const resolved = canonicalize(dbPath);
  const tmpRoot = canonicalize(tmpdir());
  if (resolved !== tmpRoot && !resolved.startsWith(tmpRoot + sep)) {
    throw new Error(
      [
        `assertNotLiveDb refused: ${dbPath} resolves to ${resolved}, which is not under ${tmpRoot}.`,
        "",
        "Test code must never destructively touch a DB path outside the",
        "process temp directory. If you're seeing this in a passing test,",
        "the test-preload likely didn't run (the verifier should have",
        "caught that already — investigate why it didn't).",
      ].join("\n"),
    );
  }
}

/**
 * Remove a SQLite DB file and its sibling `-shm` / `-wal` files. Always
 * `force: true` (no error if the file doesn't exist yet). Guarded by
 * `assertNotLiveDb` so a test can never destroy a non-tmpdir path.
 *
 * Caller passes `dbPath` (typically `getDbPath()` from the test file)
 * to keep this helper free of source-module imports.
 */
export function removeTestDbFiles(dbPath: string): void {
  assertNotLiveDb(dbPath);
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

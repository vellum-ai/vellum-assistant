/**
 * Per-callsite guard for destructive operations against a DB path.
 *
 * Use immediately before any `rmSync(dbPath, ...)` (or sibling
 * `${dbPath}-shm` / `${dbPath}-wal`) in test code:
 *
 *   import { assertNotLiveDb } from "./assert-not-live-db.js";
 *
 *   assertNotLiveDb(dbPath);
 *   rmSync(dbPath, { force: true });
 *
 * Defence-in-depth complement to the test-preload-verifier
 * (`os.tmpdir()` containment check during preload). If a future bug
 * lets a test see a non-tmpdir path despite the preload guard, every
 * destructive call still has its own line of defence.
 *
 * Positive assertion: the path MUST resolve under `os.tmpdir()`. Same
 * shape as the preload verifier — no enumeration of "real" paths, works
 * across every deployment.
 *
 * No source-module imports — only node stdlib. Helpers in `__tests__/`
 * must not import from `src/` (see assistant/AGENTS.md).
 */

import { realpathSync } from "node:fs";
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

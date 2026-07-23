/**
 * Memory-v3 lanes-version token — the cross-process lane-invalidation signal.
 *
 * Memory jobs (the consolidation run's `memory_v3_maintain` follow-up) execute
 * in the standalone memory worker process, so their in-process memo clear is
 * invisible to the daemon — the process that owns the live lanes used by the
 * live turn. A writer bumps this token whenever the underlying pages change;
 * the reader (`getLanes` in `shadow-plugin.ts`) compares it per turn against
 * the value captured at its last build and rebuilds on any change. The value
 * is opaque — only inequality matters.
 *
 * The token is plugin-owned state: it lives in the memory plugin's own storage
 * directory (`<workspace>/plugins-data/default-memory/lanes-version`, the
 * default-plugin `pluginStorageDir`), NOT in the main database. Both processes
 * reach it because they share the workspace volume. Callers pass the workspace
 * dir (resolved via `getWorkspaceDir()`), so the daemon and the worker address
 * the same file.
 */

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * `<workspace>/plugins-data/default-memory/lanes-version` — inside the memory
 * plugin's own storage directory (`<workspaceDir>/plugins-data/<manifest-name>/`,
 * the `pluginStorageDir` bootstrap derives for default plugins).
 */
function lanesVersionPath(workspaceDir: string): string {
  return join(workspaceDir, "plugins-data", "default-memory", "lanes-version");
}

/**
 * Read the persisted lanes-version token:
 *   - a non-empty string → the current token;
 *   - `null` → no token has been written yet (the file is absent), a legitimate
 *     stable state carrying the same meaning an absent value did before;
 *   - `undefined` → the read itself failed (the path exists but is unreadable),
 *     so the caller cannot judge staleness and keeps serving its memo —
 *     degraded freshness beats a broken turn.
 */
export function readLanesVersion(
  workspaceDir: string,
): string | null | undefined {
  try {
    const token = readFileSync(lanesVersionPath(workspaceDir), "utf-8").trim();
    return token.length > 0 ? token : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return undefined;
  }
}

/**
 * Bump the token to a fresh opaque value and return it. The write is atomic
 * (temp file + rename), so a concurrent reader never observes a partial write —
 * it sees either the prior token or the new one. The state directory is created
 * on demand.
 *
 * Throws on an I/O failure; the sole caller (`invalidateLanes`) wraps this in
 * its best-effort try/catch, so a failed bump only degrades cross-process
 * freshness (the local invalidation still holds) and never breaks the turn.
 */
export function bumpLanesVersion(workspaceDir: string): string {
  const token = randomUUID();
  const path = lanesVersionPath(workspaceDir);
  const tmpPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmpPath, token, "utf-8");
    renameSync(tmpPath, path);
  } catch (err) {
    // Best-effort cleanup so a failed rename does not leak the temp file into
    // the state directory.
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore — the temp file may never have been created.
    }
    throw err;
  }
  return token;
}

/**
 * True when any segment of the workspace-relative path is dot-prefixed
 * (e.g. `.env`, `.hidden/notes.md`). Hidden paths are read-only in the
 * workspace UI — the daemon rejects writes/deletes to them.
 */
export function isHiddenPath(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

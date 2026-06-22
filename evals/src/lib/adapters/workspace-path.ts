/**
 * Validate a workspace-relative path before staging a file into an agent
 * container. Rejects absolute paths (would escape the workspace root) and any
 * segment equal to `..` (path-traversal escape). Empty paths are rejected so a
 * typo can't write at the workspace root with an unnamed file.
 *
 * Shared by every adapter that stages `stage-workspace-file` payloads, so the
 * containment guarantee is identical across species.
 */
export function assertSafeWorkspacePath(relPath: string): void {
  if (relPath.length === 0) {
    throw new Error("workspace path must be non-empty");
  }
  if (relPath.startsWith("/")) {
    throw new Error(
      `workspace path must be workspace-relative, got absolute path: ${relPath}`,
    );
  }
  const segments = relPath.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      throw new Error(
        `workspace path must not escape the workspace root: ${relPath}`,
      );
    }
  }
}

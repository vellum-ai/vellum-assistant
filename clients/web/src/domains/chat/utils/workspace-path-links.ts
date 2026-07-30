/**
 * Recognize workspace file paths written as bare inline code in chat — "the
 * draft is at `/workspace/drafts/notes.md`" — and normalize them to the
 * workspace-relative form the daemon's workspace routes speak.
 *
 * Recognition is conservative and produces only a *candidate*. Whether the
 * file exists is settled by a directory listing at render time
 * (`WorkspacePathLink`), so a wrong guess here costs one cache-shared request
 * and renders as plain code, never as a dead link.
 */

/** Custom tag emitted by `rehypeWorkspacePath` for a candidate path span. */
export const WORKSPACE_PATH_TAG = "workspace-path";

/**
 * Absolute paths are only recognized below a `/workspace/` root. The mount
 * point differs by deployment — hosted assistants run with the workspace at
 * `/workspace`, desktop installs use `~/.vellum/workspace` — so we anchor on
 * the last `/workspace/` segment instead of a fixed prefix. An absolute path
 * with no such segment is a host path and is left alone.
 */
export const WORKSPACE_ROOT_MARKER = "/workspace/";

/** Guards against pathological spans; real workspace paths are far shorter. */
export const MAX_WORKSPACE_PATH_LENGTH = 512;

/**
 * Segment rules every workspace-relative path must satisfy, whatever
 * recognized it. Rejects empty text, oversized text, directory shapes (trailing `/`),
 * empty segments (`a//b`), `.`/`..` traversal, and hidden segments. The daemon
 * rejects traversal outright and its tree listing omits hidden entries, so such
 * a path could never resolve.
 */
export function isWorkspaceRelativePath(relative: string): boolean {
  if (relative.length === 0 || relative.length > MAX_WORKSPACE_PATH_LENGTH) {
    return false;
  }
  if (relative.endsWith("/")) {
    return false;
  }
  return !relative
    .split("/")
    .some((segment) => segment.length === 0 || segment.startsWith("."));
}

/**
 * Characters that mean the span is a command, glob, or expression rather than
 * a plain path. Whitespace excludes whole shell invocations (`rm -rf /tmp/x`),
 * `*?[]{}` excludes globs, `:` excludes `file.ts:42` line references and
 * `https://` URLs, and the quote/redirect/substitution set excludes anything
 * assembled for a shell.
 *
 * This is intentionally over-broad: a filename containing one of these
 * characters simply renders as plain code. The cost of a miss is nothing; the
 * cost of a false positive is a confusing affordance on text that was never a
 * file reference.
 */
const NON_PATH_CHARS = /[\s`"'<>|&;:,=$*?[\]{}()\\!#]/;

/**
 * Normalize a code-span's text to a workspace-relative path, or return `null`
 * when the text isn't a plausible workspace file reference.
 *
 * Rejects, in addition to the character rules above and the shared segment
 * rules in {@link isWorkspaceRelativePath}:
 * - home-relative (`~/...`) and non-workspace absolute paths
 * - bare filenames with no directory component (`notes.md`) when written
 *   relatively, which are indistinguishable from ordinary backticked words.
 *   An absolute `/workspace/notes.md` is unambiguous and is accepted.
 */
export function toWorkspaceRelativePath(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_WORKSPACE_PATH_LENGTH) {
    return null;
  }
  if (NON_PATH_CHARS.test(text) || text.endsWith("/") || text.startsWith("~")) {
    return null;
  }

  let relative: string;
  if (text.startsWith("/")) {
    const markerIndex = text.lastIndexOf(WORKSPACE_ROOT_MARKER);
    if (markerIndex === -1) {
      return null;
    }
    relative = text.slice(markerIndex + WORKSPACE_ROOT_MARKER.length);
  } else {
    relative = text.startsWith("./") ? text.slice(2) : text;
    if (!relative.includes("/")) {
      return null;
    }
  }

  return isWorkspaceRelativePath(relative) ? relative : null;
}

/** Parent directory of a workspace-relative path (`""` for a root-level file). */
export function workspaceDirOf(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? "" : relativePath.slice(0, index);
}

/** Final path segment of a workspace-relative path. */
export function workspaceBasenameOf(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? relativePath : relativePath.slice(index + 1);
}

/**
 * Build the `vellum://workspace/` href for a confirmed path. Segments are
 * percent-encoded individually so the click handler's `decodeURIComponent`
 * round-trips back to the stored path.
 */
export function toVellumWorkspaceHref(relativePath: string): string {
  const encoded = relativePath.split("/").map(encodeURIComponent).join("/");
  return `vellum://workspace/${encoded}`;
}

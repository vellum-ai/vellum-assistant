/**
 * Recognize workspace file paths written as bare inline code in chat.
 *
 * The assistant is told to link workspace files with the `vellum://` scheme
 * (system prompt section `04-attachment`), but in practice it frequently
 * narrates a path it just read or wrote — "the draft is at
 * `/workspace/drafts/notes.md`" — as an ordinary code span. Nothing in the
 * markdown pipeline linkifies bare paths (remark-gfm only autolinks
 * scheme-bearing URLs), so those references render inert and the user has to
 * go find the file by hand.
 *
 * This module holds the pure half of the fix: deciding whether a code span is
 * a workspace path at all, and normalizing it to the workspace-relative form
 * the daemon's workspace routes speak. Recognition is deliberately
 * conservative — it only proposes a *candidate*. Whether the file actually
 * exists is settled by a directory listing at render time
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
const WORKSPACE_ROOT_MARKER = "/workspace/";

/** Guards against pathological spans; real workspace paths are far shorter. */
const MAX_PATH_LENGTH = 512;

/**
 * Characters that mean the span is a command, glob, or expression rather than
 * a plain path. Whitespace excludes whole shell invocations (`rm -rf /tmp/x`),
 * `*?[]{}` excludes globs, `:` excludes `file.ts:42` line references and
 * `https://` URLs, and the quote/redirect/substitution set excludes anything
 * assembled for a shell.
 *
 * This is intentionally over-broad: a filename containing one of these
 * characters simply renders as plain code, which is the status quo. The cost
 * of a miss is nothing; the cost of a false positive is a confusing
 * affordance on text that was never a file reference.
 */
const NON_PATH_CHARS = /[\s`"'<>|&;:,=$*?[\]{}()\\!#]/;

/**
 * Normalize a code-span's text to a workspace-relative path, or return `null`
 * when the text isn't a plausible workspace file reference.
 *
 * Rejects, in addition to the character rules above:
 * - directory-shaped text (trailing `/`) — the modal's actions are file actions
 * - home-relative (`~/...`) and non-workspace absolute paths
 * - hidden segments (`.claude/settings.json`) — the tree listing omits them by
 *   default, so they could never resolve
 * - `.`/`..` segments — the daemon rejects traversal outright
 * - bare filenames with no directory component (`notes.md`) when written
 *   relatively, which are indistinguishable from ordinary backticked words.
 *   An absolute `/workspace/notes.md` is unambiguous and is accepted.
 */
export function toWorkspaceRelativePath(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_PATH_LENGTH) {
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

  if (relative.length === 0) {
    return null;
  }
  const segments = relative.split("/");
  if (
    segments.some((segment) => segment.length === 0 || segment.startsWith("."))
  ) {
    return null;
  }
  return relative;
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

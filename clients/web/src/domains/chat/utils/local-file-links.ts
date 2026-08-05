/**
 * Classify a markdown link or image destination written by the assistant.
 *
 * `![chart](/workspace/reports/q3.png)` and `[the deck](/workspace/deck.pdf)`
 * point at files the assistant just worked with, so the renderer needs to tell
 * those apart from web URLs, `vellum://` attachment links, and anchors.
 *
 * A link destination is explicit author intent, unlike the heuristic code-span
 * recognition in `workspace-path-links.ts`: spaces, unicode, and parentheses in
 * a filename are ordinary here and stay. Only shapes the daemon's workspace
 * routes could never serve are rejected.
 */

import {
  isWorkspaceRelativePath,
  MAX_WORKSPACE_PATH_LENGTH,
  workspaceBasenameOf,
  WORKSPACE_ROOT_MARKER,
} from "@/domains/chat/utils/workspace-path-links";

export type MarkdownHrefTarget =
  | { kind: "web" }
  | { kind: "vellum" }
  | { kind: "local-file"; workspacePath: string | null; filename: string }
  | { kind: "other" };

/** URI scheme prefix: `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )` (RFC 3986). */
const SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function percentDecode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Drop a URL fragment and query string, leaving the path.
 *
 * `[the guide](docs/guide.md#intro)` names a file plus a place to scroll to
 * inside it, and only the file part addresses anything on disk. The split runs
 * on the raw href, before percent-decoding, so a `#` or `?` that is part of a
 * filename (written `%23` / `%3F`, as any correct link generator writes it)
 * survives to be decoded into the path. Fragment first, since `#` terminates
 * the URL and a `?` after it belongs to the fragment.
 */
function stripFragmentAndQuery(href: string): string {
  const path = href.split("#", 1)[0] ?? "";
  return path.split("?", 1)[0] ?? "";
}

/** Map a markdown link destination to a workspace-relative path, or null. */
export function toWorkspacePathFromHref(href: string): string | null {
  const decoded = percentDecode(stripFragmentAndQuery(href));
  if (decoded === null) {
    return null;
  }
  const text = decoded.trim();
  if (text.length === 0 || text.length > MAX_WORKSPACE_PATH_LENGTH) {
    return null;
  }
  if (text.includes("\0")) {
    return null;
  }

  let relative: string;
  if (text.startsWith("/")) {
    // The mount point is deployment-specific (hosted assistants run with the
    // workspace at `/workspace`, desktop installs under
    // `~/.vellum/.../workspace`), so anchor on the last `/workspace/` segment.
    // An absolute path with no such segment lives outside the workspace and
    // the daemon cannot serve it.
    const markerIndex = text.lastIndexOf(WORKSPACE_ROOT_MARKER);
    if (markerIndex === -1) {
      return null;
    }
    relative = text.slice(markerIndex + WORKSPACE_ROOT_MARKER.length);
  } else {
    relative = text.startsWith("./") ? text.slice(2) : text;
  }

  return isWorkspaceRelativePath(relative) ? relative : null;
}

/** Trailing path segment, decoded, for display when a path is unservable. */
function filenameFromHref(href: string): string {
  const raw = stripFragmentAndQuery(href.trim()).split("/").pop() ?? "";
  return percentDecode(raw) ?? raw;
}

/**
 * Bucket a markdown href by how the renderer should treat it. `local-file`
 * carries a `workspacePath` of `null` when the destination is a real filesystem
 * path outside the workspace: the reference is still a file reference, but the
 * daemon has no route to its bytes.
 */
export function classifyMarkdownHref(
  href: string | undefined,
): MarkdownHrefTarget {
  if (href == null) {
    return { kind: "other" };
  }
  const text = href.trim();
  if (text.length === 0 || text.startsWith("#")) {
    return { kind: "other" };
  }
  // Protocol-relative URLs inherit the page scheme, so they are web links.
  if (text.startsWith("//")) {
    return { kind: "web" };
  }

  const scheme = SCHEME_PREFIX.exec(text)?.[0];
  if (scheme) {
    const name = scheme.slice(0, -1).toLowerCase();
    if (name === "vellum") {
      return { kind: "vellum" };
    }
    if (name === "http" || name === "https") {
      return { kind: "web" };
    }
    return { kind: "other" };
  }

  const looksLikePath =
    text.startsWith("/") || text.startsWith("./") || text.includes("/");
  if (!looksLikePath) {
    return { kind: "other" };
  }

  const workspacePath = toWorkspacePathFromHref(text);
  return {
    kind: "local-file",
    workspacePath,
    filename: workspacePath
      ? workspaceBasenameOf(workspacePath)
      : filenameFromHref(text),
  };
}

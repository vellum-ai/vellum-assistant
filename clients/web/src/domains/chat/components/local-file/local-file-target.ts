/**
 * Resolve a markdown image/link destination to the workspace file it names.
 *
 * `vellum://workspace/` hrefs are percent-encoded per segment by
 * `toVellumWorkspaceHref`, so they decode back segment by segment. Everything
 * else goes through `classifyMarkdownHref`, which recognizes absolute
 * `/workspace/` paths and relative ones. A `workspacePath` of `null` means the
 * reference is still a file reference the daemon has no route to.
 */

import { classifyMarkdownHref } from "@/domains/chat/utils/local-file-links";
import {
  isWorkspaceRelativePath,
  workspaceBasenameOf,
} from "@/domains/chat/utils/workspace-path-links";

const VELLUM_WORKSPACE_PREFIX = "vellum://workspace/";

export interface LocalFileTarget {
  workspacePath: string | null;
  filename: string;
}

/** Trailing path segment of a raw href, decoded when possible. */
export function filenameFromHref(href: string): string {
  const raw = href.trim().split("/").pop() ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function decodeSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

export function resolveLocalFileTarget(href: string): LocalFileTarget {
  const text = href.trim();

  if (text.startsWith(VELLUM_WORKSPACE_PREFIX)) {
    const relative = decodeSegments(text.slice(VELLUM_WORKSPACE_PREFIX.length));
    return {
      workspacePath: isWorkspaceRelativePath(relative) ? relative : null,
      filename: workspaceBasenameOf(relative),
    };
  }

  const target = classifyMarkdownHref(text);
  if (target.kind === "local-file") {
    return { workspacePath: target.workspacePath, filename: target.filename };
  }
  return { workspacePath: null, filename: filenameFromHref(text) };
}

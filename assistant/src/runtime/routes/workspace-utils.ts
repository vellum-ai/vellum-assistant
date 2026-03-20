import { lstatSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import { getWorkspaceDir } from "../../util/platform.js";

/**
 * Resolves a user-provided relative path to an absolute path within the workspace.
 * Returns the resolved absolute path, or undefined if the path escapes the workspace root.
 */
export function resolveWorkspacePath(
  relativePath: string,
  options?: { allowHidden?: boolean },
): string | undefined {
  // Reject paths containing hidden (dot-prefixed) segments like .env, .git, .hidden/foo
  const segments = relativePath.split(/[/\\]/);
  if (
    !options?.allowHidden &&
    segments.some((s) => s.startsWith(".") && s !== "." && s !== "..")
  ) {
    return undefined;
  }

  const base = getWorkspaceDir();
  const resolved = resolve(base, relativePath);
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    return undefined;
  }

  // Canonicalize via realpath to prevent symlink traversal outside workspace.
  // For new files, realpath the nearest existing ancestor to catch symlinked
  // parent directories.
  try {
    const real = realpathSync(resolved);
    const realBase = realpathSync(base);
    if (real !== realBase && !real.startsWith(realBase + sep)) {
      return undefined;
    }
  } catch {
    // Path doesn't exist yet — walk up to the nearest existing ancestor and
    // verify *it* resolves inside the workspace.

    // Reject dangling symlinks: if the path itself is a symlink whose target
    // doesn't exist, a subsequent write would follow the symlink and could
    // create files outside the workspace boundary.
    try {
      if (lstatSync(resolved).isSymbolicLink()) {
        return undefined;
      }
    } catch {
      // lstat failed — path truly doesn't exist (not a symlink), continue
    }

    let ancestor = resolved;

    while (true) {
      const parent = resolve(ancestor, "..");
      if (parent === ancestor) break; // reached filesystem root
      ancestor = parent;
      try {
        const realAncestor = realpathSync(ancestor);
        const realBase = realpathSync(base);
        if (
          realAncestor !== realBase &&
          !realAncestor.startsWith(realBase + sep)
        ) {
          return undefined;
        }
        break;
      } catch {
        // ancestor doesn't exist either — keep walking up
      }
    }
  }

  return resolved;
}

const TEXT_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/x-sh",
  "application/x-httpd-php",
  "application/x-perl",
  "application/x-sql",
  "application/x-tex",
  "application/vnd.dart",
];

/**
 * File extensions that are known text/code files but that Bun's MIME
 * detection reports as `application/octet-stream`.
 */
const TEXT_FILE_EXTENSIONS = new Set([
  // Programming languages
  "py",
  "rb",
  "go",
  "rs",
  "swift",
  "kt",
  "kts",
  "cs",
  "scala",
  "ex",
  "exs",
  "erl",
  "hs",
  "clj",
  "cljs",
  "jl",
  "zig",
  "nim",
  "v",
  "sol",
  "r",
  // Shell / scripting
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",
  "awk",
  // Web frameworks
  "vue",
  "svelte",
  "scss",
  "sass",
  "less",
  // Config / data
  "cfg",
  "conf",
  "ini",
  "properties",
  "env",
  "gradle",
  "cmake",
  // Markup / docs
  "rst",
  "adoc",
  "org",
  "tex",
  "latex",
  // Other text formats
  "graphql",
  "gql",
  "proto",
  "tf",
  "hcl",
  "diff",
  "patch",
  "log",
  "lock",
]);

export function isTextMimeType(mimeType: string, fileName?: string): boolean {
  if (TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) {
    return true;
  }
  // Only fall back to extension check when the MIME type is genuinely unknown.
  // Specific MIME types (e.g. application/x-plist for binary plists) should be
  // trusted over the extension — overriding them risks corrupting binary files.
  if (fileName && mimeType === "application/octet-stream") {
    const ext = fileName.split(".").pop()?.toLowerCase();
    if (ext && TEXT_FILE_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

export const MAX_INLINE_TEXT_SIZE = 2 * 1024 * 1024; // 2 MB

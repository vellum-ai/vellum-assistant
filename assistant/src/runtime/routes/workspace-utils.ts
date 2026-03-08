import { resolve, sep } from "node:path";

import { getWorkspaceDir } from "../../util/platform.js";

/**
 * Resolves a user-provided relative path to an absolute path within the workspace.
 * Returns the resolved absolute path, or undefined if the path escapes the workspace root.
 */
export function resolveWorkspacePath(relativePath: string): string | undefined {
  // Reject paths containing hidden (dot-prefixed) segments like .env, .git, .hidden/foo
  const segments = relativePath.split(/[/\\]/);
  if (segments.some((s) => s.startsWith(".") && s !== "." && s !== "..")) {
    return undefined;
  }

  const base = getWorkspaceDir();
  const resolved = resolve(base, relativePath);
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    return undefined;
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
];

export function isTextMimeType(mimeType: string): boolean {
  return TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

export const MAX_INLINE_TEXT_SIZE = 2 * 1024 * 1024; // 2 MB

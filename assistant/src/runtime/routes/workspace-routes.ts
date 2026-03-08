import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { getWorkspaceDir } from "../../util/platform.js";
import { httpError } from "../http-errors.js";
import type { RouteContext, RouteDefinition } from "../http-router.js";
import {
  isTextMimeType,
  MAX_INLINE_TEXT_SIZE,
  resolveWorkspacePath,
} from "./workspace-utils.js";

interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number | undefined;
  mimeType: string | undefined;
  modifiedAt: string;
}

function handleWorkspaceTree(ctx: { url: URL }): Response {
  const requestedPath = ctx.url.searchParams.get("path") ?? "";
  const resolved = resolveWorkspacePath(requestedPath);
  if (resolved === undefined) {
    return httpError("BAD_REQUEST", "Invalid path", 400);
  }

  try {
    const dirents = readdirSync(resolved, { withFileTypes: true });
    const workspaceDir = getWorkspaceDir();

    const entries: TreeEntry[] = dirents.map((entry) => {
      const fullPath = join(resolved, entry.name);
      const isDir = entry.isDirectory();
      const stats = statSync(fullPath);
      const relativePath = fullPath.slice(workspaceDir.length + 1);

      return {
        name: entry.name,
        path: relativePath,
        type: isDir ? "directory" : "file",
        size: isDir ? undefined : stats.size,
        mimeType: isDir ? undefined : Bun.file(fullPath).type,
        modifiedAt: stats.mtime.toISOString(),
      };
    });

    // Sort: directories first, then files, alphabetically within each group
    entries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return Response.json({ path: requestedPath, entries });
  } catch {
    return httpError("NOT_FOUND", "Directory not found", 404);
  }
}

// ---------------------------------------------------------------------------
// GET /v1/workspace/file — file metadata + inline text content
// ---------------------------------------------------------------------------

function handleWorkspaceFile(ctx: RouteContext): Response {
  const path = ctx.url.searchParams.get("path");
  if (!path) {
    return httpError("BAD_REQUEST", "path query parameter is required", 400);
  }

  const resolved = resolveWorkspacePath(path);
  if (resolved === undefined) {
    return httpError("BAD_REQUEST", "Invalid path", 400);
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(resolved);
  } catch {
    return httpError("NOT_FOUND", "File not found", 404);
  }

  if (!stat.isFile()) {
    return httpError("NOT_FOUND", "File not found", 404);
  }

  const mimeType = Bun.file(resolved).type;
  const isText = isTextMimeType(mimeType);
  const isBinary = !isText;

  let content: string | undefined = undefined;
  if (isText && stat.size <= MAX_INLINE_TEXT_SIZE) {
    content = readFileSync(resolved, "utf-8");
  }

  return Response.json({
    path,
    name: basename(resolved),
    size: stat.size,
    mimeType,
    modifiedAt: stat.mtime.toISOString(),
    content: content ?? null,
    isBinary,
  });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function workspaceRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "workspace/tree",
      method: "GET",
      handler: (ctx) => handleWorkspaceTree(ctx),
    },
    {
      endpoint: "workspace/file",
      method: "GET",
      handler: (ctx) => handleWorkspaceFile(ctx),
    },
  ];
}

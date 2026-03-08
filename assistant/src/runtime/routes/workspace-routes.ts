/**
 * Route handlers for workspace file browsing and content serving.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { getWorkspaceDir } from "../../util/platform.js";
import { httpError } from "../http-errors.js";
import type { RouteContext, RouteDefinition } from "../http-router.js";
import {
  isTextMimeType,
  MAX_INLINE_TEXT_SIZE,
  resolveWorkspacePath,
} from "./workspace-utils.js";

// ---------------------------------------------------------------------------
// GET /v1/workspace/tree — directory listing
// ---------------------------------------------------------------------------

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
    return httpError(
      "BAD_REQUEST",
      "Missing required query parameter: path",
      400,
    );
  }

  const resolved = resolveWorkspacePath(path);
  if (resolved === undefined) {
    return httpError("BAD_REQUEST", "Invalid path", 400);
  }

  if (!existsSync(resolved)) {
    return httpError("NOT_FOUND", "File not found", 404);
  }

  const stat = statSync(resolved);
  if (!stat.isFile()) {
    return httpError("BAD_REQUEST", "Path is not a file", 400);
  }

  const bunFile = Bun.file(resolved);
  const mimeType = bunFile.type;
  const size = stat.size;

  const result: Record<string, unknown> = {
    path,
    mimeType,
    size,
  };

  // Inline text content for small text files
  if (isTextMimeType(mimeType) && size <= MAX_INLINE_TEXT_SIZE) {
    result.content = readFileSync(resolved, "utf-8");
  }

  return Response.json(result);
}

// ---------------------------------------------------------------------------
// GET /v1/workspace/file/content — raw file bytes with range support
// ---------------------------------------------------------------------------

function handleWorkspaceFileContent(ctx: RouteContext): Response {
  const path = ctx.url.searchParams.get("path");
  if (!path) {
    return httpError(
      "BAD_REQUEST",
      "Missing required query parameter: path",
      400,
    );
  }

  const resolved = resolveWorkspacePath(path);
  if (resolved === undefined) {
    return httpError("BAD_REQUEST", "Invalid path", 400);
  }

  if (!existsSync(resolved)) {
    return httpError("NOT_FOUND", "File not found", 404);
  }

  const file = Bun.file(resolved);
  const fileSize = file.size;
  const mimeType = file.type;

  const rangeHeader = ctx.req.headers.get("Range");

  if (rangeHeader) {
    let start: number;
    let end: number;

    // Parse suffix range: bytes=-N (last N bytes)
    const suffixMatch = rangeHeader.match(/bytes=-(\d+)/);
    if (suffixMatch) {
      const suffixLen = parseInt(suffixMatch[1]);
      start = Math.max(0, fileSize - suffixLen);
      end = fileSize - 1;
    } else {
      // Parse standard range: bytes=start-end
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (!match) {
        // Unparseable range — return full file
        return new Response(file, {
          headers: {
            "Content-Type": mimeType,
            "Content-Length": String(fileSize),
            "Accept-Ranges": "bytes",
          },
        });
      }
      start = parseInt(match[1]);
      end = match[2] ? parseInt(match[2]) : fileSize - 1;
    }

    // Clamp end to file size
    end = Math.min(end, fileSize - 1);

    // Reject invalid ranges
    if (start > end || start >= fileSize) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${fileSize}` },
      });
    }

    const slice = file.slice(start, end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        "Content-Type": mimeType,
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
      },
    });
  }

  return new Response(file, {
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(fileSize),
      "Accept-Ranges": "bytes",
    },
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
      endpoint: "workspace/file/content",
      method: "GET",
      handler: (ctx) => handleWorkspaceFileContent(ctx),
    },
    {
      endpoint: "workspace/file",
      method: "GET",
      handler: (ctx) => handleWorkspaceFile(ctx),
    },
  ];
}

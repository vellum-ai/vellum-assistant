/**
 * Route handlers for workspace file browsing and content serving.
 *
 * WARNING: Workspace contents are included in diagnostic log exports.
 * Do not store secrets here — use the credential store or protected/ directory.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { z } from "zod";

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
  size: number | null;
  mimeType: string | null;
  modifiedAt: string;
}

function handleWorkspaceTree(ctx: RouteContext): Response {
  const requestedPath = ctx.url.searchParams.get("path") ?? "";
  const showHidden = ctx.url.searchParams.get("showHidden") === "true";
  const resolved = resolveWorkspacePath(requestedPath, {
    allowHidden: showHidden,
  });
  if (resolved === undefined) {
    return httpError("BAD_REQUEST", "Invalid path", 400);
  }

  try {
    const dirents = readdirSync(resolved, { withFileTypes: true });
    const workspaceDir = getWorkspaceDir();

    const entries: TreeEntry[] = [];
    for (const entry of dirents) {
      // Filter out dotfiles/directories (.env, .git, .private, etc.)
      if (!showHidden && entry.name.startsWith(".")) continue;

      const fullPath = join(resolved, entry.name);

      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(fullPath);
      } catch {
        // Skip entries that can't be stat'd (broken symlinks, permission denied, etc.)
        continue;
      }

      const isDir = stats.isDirectory();

      const relativePath = fullPath.slice(workspaceDir.length + 1);

      entries.push({
        name: entry.name,
        path: relativePath,
        type: isDir ? "directory" : "file",
        size: isDir ? null : stats.size,
        mimeType: isDir ? null : Bun.file(fullPath).type,
        modifiedAt: stats.mtime.toISOString(),
      });
    }

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

  const showHidden = ctx.url.searchParams.get("showHidden") === "true";
  const resolved = resolveWorkspacePath(path, { allowHidden: showHidden });
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
  const isText = isTextMimeType(mimeType, basename(resolved));
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

  const showHidden = ctx.url.searchParams.get("showHidden") === "true";
  const resolved = resolveWorkspacePath(path, { allowHidden: showHidden });
  if (resolved === undefined) {
    return httpError("BAD_REQUEST", "Invalid path", 400);
  }

  if (!existsSync(resolved)) {
    return httpError("NOT_FOUND", "File not found", 404);
  }

  try {
    if (!statSync(resolved).isFile()) {
      return httpError("BAD_REQUEST", "Path is not a file", 400);
    }
  } catch {
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
// POST /v1/workspace/write — create or overwrite a file
// ---------------------------------------------------------------------------

async function handleWorkspaceWrite(ctx: RouteContext): Promise<Response> {
  const body = (await ctx.req.json()) as {
    path?: string;
    content?: string;
    encoding?: string;
  };

  const { path, content, encoding } = body;

  if (!path || typeof path !== "string") {
    return httpError("BAD_REQUEST", "path is required", 400);
  }

  if (content !== undefined && typeof content !== "string") {
    return httpError("BAD_REQUEST", "content must be a string", 400);
  }

  const resolved = resolveWorkspacePath(path);
  if (resolved === undefined) {
    return httpError("BAD_REQUEST", "Invalid path", 400);
  }

  const buffer =
    encoding === "base64"
      ? Buffer.from(content ?? "", "base64")
      : Buffer.from(content ?? "", "utf-8");

  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    return httpError("CONFLICT", "Path is a directory", 409);
  }

  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, buffer);

  return Response.json({ path, size: buffer.byteLength }, { status: 201 });
}

// ---------------------------------------------------------------------------
// POST /v1/workspace/mkdir — create directories
// ---------------------------------------------------------------------------

async function handleWorkspaceMkdir(ctx: RouteContext): Promise<Response> {
  const body = (await ctx.req.json()) as { path?: string };
  const path = body.path;
  if (!path) {
    return httpError("BAD_REQUEST", "path is required", 400);
  }

  const resolved = resolveWorkspacePath(path);
  if (resolved === undefined) {
    return httpError("BAD_REQUEST", "Invalid path", 400);
  }

  if (existsSync(resolved)) {
    if (statSync(resolved).isDirectory()) {
      return Response.json({ path }, { status: 200 });
    }
    return httpError("CONFLICT", "Path exists as a file", 409);
  }

  mkdirSync(resolved, { recursive: true });
  return Response.json({ path }, { status: 201 });
}

// ---------------------------------------------------------------------------
// POST /v1/workspace/rename — rename/move files and directories
// ---------------------------------------------------------------------------

async function handleWorkspaceRename(ctx: RouteContext): Promise<Response> {
  const body = (await ctx.req.json()) as {
    oldPath?: string;
    newPath?: string;
  };
  const { oldPath, newPath } = body;
  if (!oldPath || !newPath) {
    return httpError("BAD_REQUEST", "oldPath and newPath are required", 400);
  }

  const resolvedOld = resolveWorkspacePath(oldPath);
  if (resolvedOld === undefined) {
    return httpError("BAD_REQUEST", "Invalid oldPath", 400);
  }

  const resolvedNew = resolveWorkspacePath(newPath);
  if (resolvedNew === undefined) {
    return httpError("BAD_REQUEST", "Invalid newPath", 400);
  }

  const workspaceDir = getWorkspaceDir();
  if (resolvedOld === workspaceDir || resolvedNew === workspaceDir) {
    return httpError("BAD_REQUEST", "Cannot rename workspace root", 400);
  }

  if (!existsSync(resolvedOld)) {
    return httpError("NOT_FOUND", "Source path not found", 404);
  }

  if (existsSync(resolvedNew)) {
    return httpError("CONFLICT", "Destination already exists", 409);
  }

  mkdirSync(dirname(resolvedNew), { recursive: true });
  renameSync(resolvedOld, resolvedNew);
  return Response.json({ oldPath, newPath }, { status: 200 });
}

// ---------------------------------------------------------------------------
// POST /v1/workspace/delete — delete files and directories
// ---------------------------------------------------------------------------

async function handleWorkspaceDelete(ctx: RouteContext): Promise<Response> {
  const body = (await ctx.req.json()) as { path?: string };
  const path = body.path;
  if (!path) {
    return httpError("BAD_REQUEST", "path is required", 400);
  }

  const resolved = resolveWorkspacePath(path);
  if (resolved === undefined) {
    return httpError("BAD_REQUEST", "Invalid path", 400);
  }

  if (resolved === getWorkspaceDir()) {
    return httpError("BAD_REQUEST", "Cannot delete workspace root", 400);
  }

  if (!existsSync(resolved)) {
    return httpError("NOT_FOUND", "Path not found", 404);
  }

  rmSync(resolved, { recursive: true, force: true });
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function workspaceRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "workspace/tree",
      method: "GET",
      summary: "List workspace directory",
      description: "Return directory entries for a workspace path.",
      tags: ["workspace"],
      queryParams: [
        {
          name: "path",
          schema: { type: "string" },
          description: "Relative path (default root)",
        },
        {
          name: "showHidden",
          schema: { type: "string" },
          description: "Include dotfiles (true/false)",
        },
      ],
      responseBody: z.object({
        path: z.string(),
        entries: z.array(z.unknown()).describe("Directory entry objects"),
      }),
      handler: (ctx) => handleWorkspaceTree(ctx),
    },
    {
      endpoint: "workspace/file/content",
      method: "GET",
      summary: "Get workspace file content",
      description: "Return raw file bytes with HTTP range support.",
      tags: ["workspace"],
      queryParams: [
        {
          name: "path",
          schema: { type: "string" },
          description: "Relative file path (required)",
        },
        {
          name: "showHidden",
          schema: { type: "string" },
          description: "Allow hidden files (true/false)",
        },
      ],
      handler: (ctx) => handleWorkspaceFileContent(ctx),
    },
    {
      endpoint: "workspace/file",
      method: "GET",
      summary: "Get workspace file metadata",
      description:
        "Return file metadata and inline text content (if small enough).",
      tags: ["workspace"],
      queryParams: [
        {
          name: "path",
          schema: { type: "string" },
          description: "Relative file path (required)",
        },
        {
          name: "showHidden",
          schema: { type: "string" },
          description: "Allow hidden files (true/false)",
        },
      ],
      responseBody: z.object({
        path: z.string(),
        name: z.string(),
        size: z.number(),
        mimeType: z.string(),
        modifiedAt: z.string(),
        content: z.string().describe("Inline text content or null"),
        isBinary: z.boolean(),
      }),
      handler: (ctx) => handleWorkspaceFile(ctx),
    },
    {
      endpoint: "workspace/write",
      method: "POST",
      summary: "Write workspace file",
      description: "Create or overwrite a file in the workspace.",
      tags: ["workspace"],
      requestBody: z.object({
        path: z.string().describe("Relative file path"),
        content: z.string().describe("File content").optional(),
        encoding: z
          .string()
          .describe("Content encoding (base64 or utf-8)")
          .optional(),
      }),
      responseBody: z.object({
        path: z.string(),
        size: z.number(),
      }),
      handler: (ctx) => handleWorkspaceWrite(ctx),
    },
    {
      endpoint: "workspace/mkdir",
      method: "POST",
      summary: "Create workspace directory",
      description: "Create directories recursively in the workspace.",
      tags: ["workspace"],
      requestBody: z.object({
        path: z.string().describe("Relative directory path"),
      }),
      responseBody: z.object({
        path: z.string(),
      }),
      handler: (ctx) => handleWorkspaceMkdir(ctx),
    },
    {
      endpoint: "workspace/rename",
      method: "POST",
      summary: "Rename workspace entry",
      description: "Rename or move a file or directory in the workspace.",
      tags: ["workspace"],
      requestBody: z.object({
        oldPath: z.string().describe("Current relative path"),
        newPath: z.string().describe("New relative path"),
      }),
      responseBody: z.object({
        oldPath: z.string(),
        newPath: z.string(),
      }),
      handler: (ctx) => handleWorkspaceRename(ctx),
    },
    {
      endpoint: "workspace/delete",
      method: "POST",
      summary: "Delete workspace entry",
      description: "Delete a file or directory from the workspace.",
      tags: ["workspace"],
      requestBody: z.object({
        path: z.string().describe("Relative path to delete"),
      }),
      handler: (ctx) => handleWorkspaceDelete(ctx),
    },
  ];
}

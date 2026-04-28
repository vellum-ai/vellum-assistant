/**
 * Route handlers for workspace file browsing and content serving.
 *
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
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  RangeNotSatisfiableError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";
import { RouteResponse } from "./types.js";
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

// ---------------------------------------------------------------------------
// GET /v1/workspace/tree — list directory contents
// ---------------------------------------------------------------------------

function handleWorkspaceTree({ queryParams }: RouteHandlerArgs) {
  const requestedPath = queryParams?.path ?? "";
  const showHidden = queryParams?.showHidden === "true";
  const resolved = resolveWorkspacePath(requestedPath, {
    allowHidden: showHidden,
  });
  if (resolved === undefined) {
    throw new BadRequestError("Invalid path");
  }

  try {
    const dirents = readdirSync(resolved, { withFileTypes: true });
    const workspaceDir = getWorkspaceDir();

    const entries: TreeEntry[] = [];
    for (const entry of dirents) {
      if (!showHidden && entry.name.startsWith(".")) continue;

      const fullPath = join(resolved, entry.name);

      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(fullPath);
      } catch {
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

    entries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return { path: requestedPath, entries };
  } catch {
    throw new NotFoundError("Directory not found");
  }
}

// ---------------------------------------------------------------------------
// GET /v1/workspace/file — file metadata + inline text content
// ---------------------------------------------------------------------------

function handleWorkspaceFile({ queryParams }: RouteHandlerArgs) {
  const path = queryParams?.path;
  if (!path) {
    throw new BadRequestError("path query parameter is required");
  }

  const showHidden = queryParams?.showHidden === "true";
  const resolved = resolveWorkspacePath(path, { allowHidden: showHidden });
  if (resolved === undefined) {
    throw new BadRequestError("Invalid path");
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(resolved);
  } catch {
    throw new NotFoundError("File not found");
  }

  if (!stat.isFile()) {
    throw new NotFoundError("File not found");
  }

  const mimeType = Bun.file(resolved).type;
  const isText =
    stat.size === 0 && mimeType === "application/octet-stream"
      ? true
      : isTextMimeType(mimeType, basename(resolved));
  const isBinary = !isText;

  let content: string | undefined = undefined;
  if (isText && stat.size <= MAX_INLINE_TEXT_SIZE) {
    content = readFileSync(resolved, "utf-8");
  }

  return {
    path,
    name: basename(resolved),
    size: stat.size,
    mimeType,
    modifiedAt: stat.mtime.toISOString(),
    content: content ?? null,
    isBinary,
  };
}

// ---------------------------------------------------------------------------
// GET /v1/workspace/file/content — raw file bytes with range support
// ---------------------------------------------------------------------------

function handleWorkspaceFileContent({
  queryParams = {},
  headers = {},
}: RouteHandlerArgs): RouteResponse {
  const path = queryParams.path;
  if (!path) {
    throw new BadRequestError("Missing required query parameter: path");
  }

  const showHidden = queryParams.showHidden === "true";
  const resolved = resolveWorkspacePath(path, { allowHidden: showHidden });
  if (resolved === undefined) {
    throw new BadRequestError("Invalid path");
  }

  if (!existsSync(resolved)) {
    throw new NotFoundError("File not found");
  }

  try {
    if (!statSync(resolved).isFile()) {
      throw new BadRequestError("Path is not a file");
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new NotFoundError("File not found");
  }

  const file = Bun.file(resolved);
  const fileSize = file.size;
  const mimeType = file.type;

  const rangeHeader = headers["range"];

  if (rangeHeader) {
    let start: number;
    let end: number;

    const suffixMatch = rangeHeader.match(/bytes=-(\d+)/);
    if (suffixMatch) {
      const suffixLen = parseInt(suffixMatch[1]);
      start = Math.max(0, fileSize - suffixLen);
      end = fileSize - 1;
    } else {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (!match) {
        // Unparseable range — return full file
        return new RouteResponse(file, {
          "Content-Type": mimeType,
          "Content-Length": String(fileSize),
          "Accept-Ranges": "bytes",
        });
      }
      start = parseInt(match[1]);
      end = match[2] ? parseInt(match[2]) : fileSize - 1;
    }

    end = Math.min(end, fileSize - 1);

    if (start > end || start >= fileSize) {
      throw new RangeNotSatisfiableError(`bytes */${fileSize}`);
    }

    const slice = file.slice(start, end + 1);
    return new RouteResponse(slice, {
      "Content-Type": mimeType,
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
    });
  }

  return new RouteResponse(file, {
    "Content-Type": mimeType,
    "Content-Length": String(fileSize),
    "Accept-Ranges": "bytes",
  });
}

// ---------------------------------------------------------------------------
// POST /v1/workspace/write — create or overwrite a file
// ---------------------------------------------------------------------------

function handleWorkspaceWrite({ body }: RouteHandlerArgs) {
  const path = body?.path as string | undefined;
  const content = body?.content as string | undefined;
  const encoding = body?.encoding as string | undefined;

  if (!path || typeof path !== "string") {
    throw new BadRequestError("path is required");
  }

  if (content !== undefined && typeof content !== "string") {
    throw new BadRequestError("content must be a string");
  }

  const resolved = resolveWorkspacePath(path);
  if (resolved === undefined) {
    throw new BadRequestError("Invalid path");
  }

  const buffer =
    encoding === "base64"
      ? Buffer.from(content ?? "", "base64")
      : Buffer.from(content ?? "", "utf-8");

  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    throw new ConflictError("Path is a directory");
  }

  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, buffer);

  return { path, size: buffer.byteLength };
}

// ---------------------------------------------------------------------------
// POST /v1/workspace/mkdir — create directories
// ---------------------------------------------------------------------------

function handleWorkspaceMkdir({ body }: RouteHandlerArgs) {
  const path = body?.path as string | undefined;
  if (!path) {
    throw new BadRequestError("path is required");
  }

  const resolved = resolveWorkspacePath(path);
  if (resolved === undefined) {
    throw new BadRequestError("Invalid path");
  }

  if (existsSync(resolved)) {
    if (statSync(resolved).isDirectory()) {
      return { path };
    }
    throw new ConflictError("Path exists as a file");
  }

  mkdirSync(resolved, { recursive: true });
  return { path };
}

// ---------------------------------------------------------------------------
// POST /v1/workspace/rename — rename/move files and directories
// ---------------------------------------------------------------------------

function handleWorkspaceRename({ body }: RouteHandlerArgs) {
  const oldPath = body?.oldPath as string | undefined;
  const newPath = body?.newPath as string | undefined;
  if (!oldPath || !newPath) {
    throw new BadRequestError("oldPath and newPath are required");
  }

  const resolvedOld = resolveWorkspacePath(oldPath);
  if (resolvedOld === undefined) {
    throw new BadRequestError("Invalid oldPath");
  }

  const resolvedNew = resolveWorkspacePath(newPath);
  if (resolvedNew === undefined) {
    throw new BadRequestError("Invalid newPath");
  }

  const workspaceDir = getWorkspaceDir();
  if (resolvedOld === workspaceDir || resolvedNew === workspaceDir) {
    throw new BadRequestError("Cannot rename workspace root");
  }

  if (!existsSync(resolvedOld)) {
    throw new NotFoundError("Source path not found");
  }

  if (existsSync(resolvedNew)) {
    throw new ConflictError("Destination already exists");
  }

  mkdirSync(dirname(resolvedNew), { recursive: true });
  renameSync(resolvedOld, resolvedNew);
  return { oldPath, newPath };
}

// ---------------------------------------------------------------------------
// POST /v1/workspace/delete — delete files and directories
// ---------------------------------------------------------------------------

function handleWorkspaceDelete({ body }: RouteHandlerArgs) {
  const path = body?.path as string | undefined;
  if (!path) {
    throw new BadRequestError("path is required");
  }

  const resolved = resolveWorkspacePath(path);
  if (resolved === undefined) {
    throw new BadRequestError("Invalid path");
  }

  if (resolved === getWorkspaceDir()) {
    throw new BadRequestError("Cannot delete workspace root");
  }

  if (!existsSync(resolved)) {
    throw new NotFoundError("Path not found");
  }

  rmSync(resolved, { recursive: true, force: true });
  return { success: true };
}

// ---------------------------------------------------------------------------
// Transport-agnostic route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "workspace_tree",
    endpoint: "workspace/tree",
    method: "GET",
    summary: "List workspace directory",
    description: "Return directory entries for a workspace path.",
    tags: ["workspace"],
    queryParams: [
      {
        name: "path",
        description: "Relative path (default root)",
      },
      {
        name: "showHidden",
        description: "Include dotfiles (true/false)",
      },
    ],
    responseBody: z.object({
      path: z.string(),
      entries: z.array(z.unknown()).describe("Directory entry objects"),
    }),
    handler: handleWorkspaceTree,
  },
  {
    operationId: "workspace_file",
    endpoint: "workspace/file",
    method: "GET",
    summary: "Get workspace file metadata",
    description:
      "Return file metadata and inline text content (if small enough).",
    tags: ["workspace"],
    queryParams: [
      {
        name: "path",
        description: "Relative file path (required)",
      },
      {
        name: "showHidden",
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
    handler: handleWorkspaceFile,
  },
  {
    operationId: "workspace_write",
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
    handler: handleWorkspaceWrite,
  },
  {
    operationId: "workspace_mkdir",
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
    handler: handleWorkspaceMkdir,
  },
  {
    operationId: "workspace_rename",
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
    handler: handleWorkspaceRename,
  },
  {
    operationId: "workspace_delete",
    endpoint: "workspace/delete",
    method: "POST",
    summary: "Delete workspace entry",
    description: "Delete a file or directory from the workspace.",
    tags: ["workspace"],
    requestBody: z.object({
      path: z.string().describe("Relative path to delete"),
    }),
    responseBody: z.object({
      success: z.boolean(),
    }),
    handler: handleWorkspaceDelete,
  },
  {
    operationId: "workspace_file_content",
    endpoint: "workspace/file/content",
    method: "GET",
    summary: "Get workspace file content",
    description: "Return raw file bytes with HTTP range support.",
    tags: ["workspace"],
    queryParams: [
      {
        name: "path",
        type: "string",
        required: true,
        description: "Relative file path",
      },
      {
        name: "showHidden",
        type: "string",
        description: "Allow hidden files (true/false)",
      },
    ],
    responseStatus: ({ headers }) => (headers?.["range"] ? "206" : "200"),
    additionalResponses: {
      "416": { description: "Range Not Satisfiable" },
    },
    handler: handleWorkspaceFileContent,
  },
];

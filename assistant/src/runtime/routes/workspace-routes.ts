/**
 * Route handlers for workspace file browsing and content serving.
 *
 * Do not store secrets here — use the credential store or protected/ directory.
 */
import {
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { z } from "zod";

import { getWorkspaceDir } from "../../util/platform.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { publishSoundsConfigUpdated } from "../sync/resource-sync-events.js";
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

const workspaceTreeEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "directory"]),
  size: z.number().nullable(),
  mimeType: z.string().nullable(),
  modifiedAt: z.string(),
});

type TreeEntry = z.infer<typeof workspaceTreeEntrySchema>;

// Recursive directory sizing walks the filesystem synchronously, so it is
// bounded by two caps that work together:
//
// - `DIR_SIZE_PER_DIR_ENTRY_BUDGET` caps a single directory. No one giant
//   subtree (e.g. a `node_modules/` or `repos/` checkout) can consume the whole
//   listing's budget and starve its siblings; only the oversized directory
//   itself reports `size: null` (the caller renders an unknown-size
//   placeholder) while every other folder still shows an accurate size.
// - `DIR_SIZE_TOTAL_ENTRY_BUDGET` caps the listing as a whole, so a workspace
//   with many large sibling directories still can't block the daemon event loop
//   for an unbounded amount of time. Once it is exhausted, the remaining
//   directories report `size: null`.
//
// Each directory is allotted `min(per-dir cap, remaining listing budget)`
// entries, and whatever it actually consumes is deducted from the listing
// budget.
const DIR_SIZE_PER_DIR_ENTRY_BUDGET = 250_000;
const DIR_SIZE_TOTAL_ENTRY_BUDGET = 1_000_000;

interface DirSizeBudget {
  remaining: number;
}

/**
 * Recursively sum the byte size of every regular file under `absPath`,
 * traversing up to `budget.remaining` filesystem entries.
 *
 * Returns:
 * - the total size in bytes when the entire subtree was traversed within
 *   budget
 * - `null` if the budget was exhausted before completion (the caller surfaces
 *   that as an unknown size in the UI)
 *
 * Symlinks are not followed. We rely on `withFileTypes` so we never `stat`
 * directories purely to discover their type.
 */
function computeDirSize(absPath: string, budget: DirSizeBudget): number | null {
  if (budget.remaining <= 0) return null;

  let total = 0;
  const stack: string[] = [absPath];

  while (stack.length > 0) {
    const dir = stack.pop()!;

    let dirents: Dirent[];
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of dirents) {
      if (budget.remaining <= 0) return null;
      budget.remaining -= 1;

      if (entry.isDirectory()) {
        stack.push(join(dir, entry.name));
      } else if (entry.isFile()) {
        try {
          total += statSync(join(dir, entry.name)).size;
        } catch {
          // unreadable file — skip, do not abort the whole computation
        }
      }
      // symlinks, sockets, fifos, etc. are intentionally ignored
    }
  }

  return total;
}

/**
 * Compute a directory's recursive size while drawing from a shared listing
 * budget. The directory is allotted at most `DIR_SIZE_PER_DIR_ENTRY_BUDGET`
 * entries — and never more than the listing has left — and whatever it consumes
 * is deducted from `listingBudget` so the next sibling sees the reduced
 * remainder. Returns `null` (unknown size) when the allotment is exhausted.
 */
function computeDirSizeWithinListing(
  absPath: string,
  listingBudget: DirSizeBudget,
): number | null {
  const allotment = Math.min(
    DIR_SIZE_PER_DIR_ENTRY_BUDGET,
    listingBudget.remaining,
  );
  const dirBudget: DirSizeBudget = { remaining: allotment };
  const size = computeDirSize(absPath, dirBudget);
  listingBudget.remaining -= allotment - dirBudget.remaining;
  return size;
}

const SOUNDS_WORKSPACE_PATH = "data/sounds";

function normaliseWorkspacePathForSync(path: string): string {
  return path
    .split(/[\\/]+/)
    .filter((part) => part.length > 0)
    .join("/");
}

function isSoundsWorkspacePath(path: string): boolean {
  const normalized = normaliseWorkspacePathForSync(path);
  return (
    normalized === SOUNDS_WORKSPACE_PATH ||
    normalized.startsWith(`${SOUNDS_WORKSPACE_PATH}/`)
  );
}

function publishSoundsConfigUpdatedForPaths(
  paths: string[],
  originClientId?: string,
): void {
  if (paths.some(isSoundsWorkspacePath)) {
    publishSoundsConfigUpdated(originClientId);
  }
}

// ---------------------------------------------------------------------------
// GET /v1/workspace/tree — list directory contents
// ---------------------------------------------------------------------------

function handleWorkspaceTree({ queryParams }: RouteHandlerArgs) {
  const requestedPath = queryParams?.path ?? "";
  const showHidden = queryParams?.showHidden === "true";
  const includeDirSizes = queryParams?.includeDirSizes === "true";
  const resolved = resolveWorkspacePath(requestedPath, {
    allowHidden: showHidden,
  });
  if (resolved === undefined) {
    throw new BadRequestError("Invalid path");
  }

  try {
    const dirents = readdirSync(resolved, { withFileTypes: true });
    const workspaceDir = getWorkspaceDir();

    // Listing-wide budget, only constructed when sizes are requested. Each
    // directory draws a per-directory allotment from it so one oversized
    // subtree can't starve its siblings, while the shared remainder still caps
    // total synchronous traversal for the whole listing.
    const listingBudget: DirSizeBudget | undefined = includeDirSizes
      ? { remaining: DIR_SIZE_TOTAL_ENTRY_BUDGET }
      : undefined;

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

      const dirSize =
        isDir && listingBudget
          ? computeDirSizeWithinListing(fullPath, listingBudget)
          : null;

      entries.push({
        name: entry.name,
        path: relativePath,
        type: isDir ? "directory" : "file",
        size: isDir ? dirSize : stats.size,
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
        // Unparseable range — return full file at 200 (not 206)
        return new RouteResponse(
          file,
          {
            "Content-Type": mimeType,
            "Content-Length": String(fileSize),
            "Accept-Ranges": "bytes",
          },
          200,
        );
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

function handleWorkspaceWrite({ body, headers }: RouteHandlerArgs) {
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
  publishSoundsConfigUpdatedForPaths(
    [path],
    headers?.["x-vellum-client-id"]?.trim() || undefined,
  );

  return { path, size: buffer.byteLength };
}

// ---------------------------------------------------------------------------
// POST /v1/workspace/mkdir — create directories
// ---------------------------------------------------------------------------

function handleWorkspaceMkdir({ body, headers }: RouteHandlerArgs) {
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
  publishSoundsConfigUpdatedForPaths(
    [path],
    headers?.["x-vellum-client-id"]?.trim() || undefined,
  );
  return { path };
}

// ---------------------------------------------------------------------------
// POST /v1/workspace/rename — rename/move files and directories
// ---------------------------------------------------------------------------

/**
 * On case-insensitive filesystems (macOS/iOS defaults) a case-only rename's
 * destination "exists" because it resolves to the source itself. Treat only
 * true path aliases of one directory entry as the same file:
 * - lstat, not stat, so two symlinks to one target stay distinct entries;
 * - matching inodes alone are not enough — hard links share an inode while
 *   being distinct entries, and POSIX rename() between two hard links is a
 *   silent no-op. realpath canonicalizes case/normalization aliases of the
 *   same entry to one string, while distinct entries keep distinct names.
 */
function isSamePathAlias(a: string, b: string): boolean {
  try {
    const statA = lstatSync(a);
    const statB = lstatSync(b);
    if (statA.dev !== statB.dev || statA.ino !== statB.ino) {
      return false;
    }
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function handleWorkspaceRename({ body, headers }: RouteHandlerArgs) {
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

  if (existsSync(resolvedNew) && !isSamePathAlias(resolvedOld, resolvedNew)) {
    throw new ConflictError("Destination already exists");
  }

  mkdirSync(dirname(resolvedNew), { recursive: true });
  renameSync(resolvedOld, resolvedNew);
  publishSoundsConfigUpdatedForPaths(
    [oldPath, newPath],
    headers?.["x-vellum-client-id"]?.trim() || undefined,
  );
  return { oldPath, newPath };
}

// ---------------------------------------------------------------------------
// POST /v1/workspace/delete — delete files and directories
// ---------------------------------------------------------------------------

function handleWorkspaceDelete({ body, headers }: RouteHandlerArgs) {
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
  publishSoundsConfigUpdatedForPaths(
    [path],
    headers?.["x-vellum-client-id"]?.trim() || undefined,
  );
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
      {
        name: "includeDirSizes",
        description:
          "Compute recursive byte size for each directory entry (true/false). Budget-bounded — large subtrees may return size: null.",
      },
    ],
    responseBody: z.object({
      path: z.string(),
      entries: z
        .array(workspaceTreeEntrySchema)
        .describe("Directory entry objects"),
    }),
    handler: handleWorkspaceTree,
  },
  {
    operationId: "workspace_file",
    endpoint: "workspace/file",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    responseBody: {
      contentType: "application/octet-stream",
      schema: { type: "string", format: "binary" },
    },
    responseStatus: ({ headers }) => (headers?.["range"] ? "206" : "200"),
    additionalResponses: {
      "416": { description: "Range Not Satisfiable" },
    },
    handler: handleWorkspaceFileContent,
  },
];

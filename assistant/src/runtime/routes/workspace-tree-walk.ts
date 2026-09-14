/**
 * The directory walk behind GET /v1/workspace/tree.
 *
 * One directory by default. With `recursive`, the whole subtree in one
 * response, so a client can search or expand without a request per folder.
 * The walk yields the event loop between directories and is bounded by an
 * entry cap and a deadline; it does not descend into the runtime-state
 * directories the workspace's own gitignore rules name.
 */
import type { Dirent, Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";

import ignore from "ignore";

import { WORKSPACE_GITIGNORE_RULES } from "../../workspace/git-service.js";
import type { WorkspaceEntry } from "./workspace-utils.js";

/**
 * Entries a recursive listing returns before it stops descending and
 * reports `truncated`. The root's own listing is always whole, so the
 * answer is never worse than a non-recursive one.
 */
export const MAX_RECURSIVE_ENTRIES = 20_000;

/** Wall-clock budget for one recursive walk. */
export const MAX_RECURSIVE_WALK_MS = 3_000;

/**
 * Directories the recursive walk lists but does not enter: whatever the
 * workspace's own gitignore rules exclude (databases, caches, dependency
 * trees, logs), which is the one maintained statement of what in a
 * workspace is runtime state rather than the user's files. Files those rules
 * match are still listed; only descent is decided here.
 */
const descentRules = ignore().add(WORKSPACE_GITIGNORE_RULES);

/** git never lists its own metadata directory, and neither does this walk. */
const GIT_DIR = ".git";

function isDescentSkipped(relativeDirPath: string, name: string): boolean {
  return name === GIT_DIR || descentRules.ignores(`${relativeDirPath}/`);
}

export interface WorkspaceTreeWalk {
  entries: WorkspaceEntry[];
  /** The entry cap or the deadline stopped a recursive walk early. */
  truncated: boolean;
  /** Workspace-relative directories the walk listed but did not enter. */
  skipped: string[];
}

export interface WorkspaceTreeWalkOptions {
  /** Absolute directory to list. */
  rootPath: string;
  /** Absolute workspace root; entry paths are relative to it. */
  workspaceDir: string;
  showHidden: boolean;
  recursive: boolean;
  /**
   * Per-directory size for directory entries in a non-recursive listing.
   * Ignored when `recursive`, where directories report `size: null`.
   */
  directorySize?: (absPath: string) => number | null;
  maxEntries?: number;
  maxWalkMs?: number;
}

function byDirectoriesThenName(a: WorkspaceEntry, b: WorkspaceEntry): number {
  if (a.type !== b.type) {
    return a.type === "directory" ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

interface ListedDirectory {
  entries: WorkspaceEntry[];
  /** Directory entries in listing order, with whether each is a symlink. */
  subdirectories: Array<{
    absPath: string;
    relativePath: string;
    name: string;
    isSymlink: boolean;
  }>;
}

/**
 * One directory's entries, sorted directories first then by name. Types
 * follow `stat`, so a symlinked directory reads as a directory; the caller
 * decides whether to enter it.
 */
async function listDirectory(
  absDir: string,
  { workspaceDir, showHidden, directorySize }: WorkspaceTreeWalkOptions,
): Promise<ListedDirectory> {
  const dirents: Dirent[] = await readdir(absDir, { withFileTypes: true });
  const entries: WorkspaceEntry[] = [];
  const subdirectories: ListedDirectory["subdirectories"] = [];

  for (const dirent of dirents) {
    if (!showHidden && dirent.name.startsWith(".")) {
      continue;
    }
    const absPath = join(absDir, dirent.name);
    let stats: Stats;
    try {
      stats = await stat(absPath);
    } catch {
      continue;
    }
    const isDir = stats.isDirectory();
    // Wire paths use "/" on every host; clients key expansion and
    // ancestry on them and never see the daemon's own separator.
    const relativePath = absPath
      .slice(workspaceDir.length + 1)
      .split(sep)
      .join("/");
    entries.push({
      name: dirent.name,
      path: relativePath,
      type: isDir ? "directory" : "file",
      size: isDir ? (directorySize?.(absPath) ?? null) : stats.size,
      mimeType: isDir ? null : Bun.file(absPath).type,
      modifiedAt: stats.mtime.toISOString(),
    });
    if (isDir) {
      subdirectories.push({
        absPath,
        relativePath,
        name: dirent.name,
        isSymlink: dirent.isSymbolicLink(),
      });
    }
  }

  entries.sort(byDirectoriesThenName);
  subdirectories.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, subdirectories };
}

/**
 * List `rootPath`. A recursive walk is depth-first with each directory's
 * entries in listing order, so grouping the result by parent path gives
 * every directory's listing exactly as a non-recursive request would.
 *
 * Symlinked directories are listed but never entered, so a link cannot make
 * the walk cycle or leave the workspace. The root's own read error is the
 * caller's to report; an unreadable directory found mid-walk is left empty.
 */
export async function walkWorkspaceTree(
  options: WorkspaceTreeWalkOptions,
): Promise<WorkspaceTreeWalk> {
  const {
    rootPath,
    recursive,
    maxEntries = MAX_RECURSIVE_ENTRIES,
    maxWalkMs = MAX_RECURSIVE_WALK_MS,
  } = options;
  // A recursive listing carries every file, so a client sums directory
  // sizes itself and no per-directory sizer runs.
  const listOptions = recursive
    ? { ...options, directorySize: undefined }
    : options;
  const root = await listDirectory(rootPath, listOptions);
  if (!recursive) {
    return { entries: root.entries, truncated: false, skipped: [] };
  }

  const deadline = Date.now() + maxWalkMs;
  const entries: WorkspaceEntry[] = [...root.entries];
  const skipped: string[] = [];
  // Reversed so the stack pops subdirectories in listing order.
  const stack = root.subdirectories.slice().reverse();

  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (dir.isSymlink) {
      continue;
    }
    if (isDescentSkipped(dir.relativePath, dir.name)) {
      skipped.push(dir.relativePath);
      continue;
    }
    if (entries.length >= maxEntries || Date.now() > deadline) {
      return { entries, truncated: true, skipped };
    }

    let listed: ListedDirectory;
    try {
      listed = await listDirectory(dir.absPath, listOptions);
    } catch {
      continue;
    }
    const room = maxEntries - entries.length;
    if (listed.entries.length > room) {
      entries.push(...listed.entries.slice(0, room));
      return { entries, truncated: true, skipped };
    }
    entries.push(...listed.entries);
    for (let i = listed.subdirectories.length - 1; i >= 0; i--) {
      stack.push(listed.subdirectories[i]);
    }
  }

  return { entries, truncated: false, skipped };
}

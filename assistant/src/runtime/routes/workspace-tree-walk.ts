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
  /**
   * Workspace-relative directories the walk listed but did not enter, for
   * any reason: a gitignore rule, a symlink, or a directory that could not
   * be read. A client that wants their contents asks for them one at a time.
   */
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
  /** Clock for the deadline. Tests hand in a scripted one. */
  now?: () => number;
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
 * What a nested directory may cost a recursive walk. The listing stops
 * before any stat work when the directory has more entries than the
 * response has room for, and between stats once the deadline passes, so a
 * single wide or slow directory cannot carry the walk past its bound.
 */
interface ListingBudget {
  room: number;
  deadline: number;
}

/**
 * One directory's entries, sorted directories first then by name. Types
 * follow `stat`, so a symlinked directory reads as a directory; the caller
 * decides whether to enter it. Returns `null` when a budget stops the
 * listing, in which case none of it is reported.
 */
async function listDirectory(
  absDir: string,
  {
    workspaceDir,
    showHidden,
    directorySize,
    now = Date.now,
  }: WorkspaceTreeWalkOptions,
  budget?: ListingBudget,
): Promise<ListedDirectory | null> {
  const dirents: Dirent[] = (
    await readdir(absDir, { withFileTypes: true })
  ).filter((dirent) => showHidden || !dirent.name.startsWith("."));
  if (budget && dirents.length > budget.room) {
    return null;
  }
  const entries: WorkspaceEntry[] = [];
  const subdirectories: ListedDirectory["subdirectories"] = [];

  for (const dirent of dirents) {
    if (budget && now() > budget.deadline) {
      return null;
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
 * entries in listing order and never part of a directory, so grouping the
 * result by parent path gives every directory's listing exactly as a
 * non-recursive request would, or nothing for it at all.
 *
 * Symlinked directories are listed but never entered, so a link cannot make
 * the walk cycle or leave the workspace; they are reported in `skipped`, as
 * is a directory found mid-walk that cannot be read. The root's own read
 * error is the caller's to report.
 */
export async function walkWorkspaceTree(
  options: WorkspaceTreeWalkOptions,
): Promise<WorkspaceTreeWalk> {
  const {
    rootPath,
    recursive,
    maxEntries = MAX_RECURSIVE_ENTRIES,
    maxWalkMs = MAX_RECURSIVE_WALK_MS,
    now = Date.now,
  } = options;
  // A recursive listing carries every file, so a client sums directory
  // sizes itself and no per-directory sizer runs.
  const listOptions = recursive
    ? { ...options, directorySize: undefined }
    : options;
  // The root is listed without a budget: its listing is always whole.
  const root = (await listDirectory(rootPath, listOptions))!;
  if (!recursive) {
    return { entries: root.entries, truncated: false, skipped: [] };
  }

  const deadline = now() + maxWalkMs;
  const entries: WorkspaceEntry[] = [...root.entries];
  const skipped: string[] = [];
  // Reversed so the stack pops subdirectories in listing order.
  const stack = root.subdirectories.slice().reverse();

  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (dir.isSymlink || isDescentSkipped(dir.relativePath, dir.name)) {
      skipped.push(dir.relativePath);
      continue;
    }
    if (entries.length >= maxEntries || now() > deadline) {
      return { entries, truncated: true, skipped };
    }

    let listed: ListedDirectory | null;
    try {
      listed = await listDirectory(dir.absPath, listOptions, {
        room: maxEntries - entries.length,
        deadline,
      });
    } catch {
      skipped.push(dir.relativePath);
      continue;
    }
    // A directory is carried whole or not at all, so a client grouping the
    // result by parent never mistakes part of a listing for all of it.
    if (listed === null) {
      return { entries, truncated: true, skipped };
    }
    entries.push(...listed.entries);
    for (let i = listed.subdirectories.length - 1; i >= 0; i--) {
      stack.push(listed.subdirectories[i]);
    }
  }

  return { entries, truncated: false, skipped };
}

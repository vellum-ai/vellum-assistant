import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Snapshot / restore for the memory-v3 data directory.
 *
 * The v3 data dir (`<workspace>/memory/v3/data/`) holds the tree's durable
 * state: `leaves/**\/*.md`, `assignments.json`, and `core.json` (see
 * `resolveDataDir` in `tree.ts`). A future tree-gardening reconciler mutates
 * these in place; this module lets it take a snapshot first and roll back if a
 * reconcile pass produces a bad tree.
 *
 * Page `leaves:` frontmatter lives outside the data dir (in the v2 page store
 * at `<workspace>/memory/concepts/`). The reconciler can capture the prior
 * page->leaves mapping as `pageRefs` and hand it to {@link snapshotDataDir};
 * it is persisted alongside the data snapshot and returned by
 * {@link restoreDataDir} so the caller can revert those external frontmatter
 * edits too.
 */

/** Files (relative to the data dir) captured by a snapshot. */
const SNAPSHOT_FILES = ["assignments.json", "core.json"] as const;
/** Directories (relative to the data dir) captured recursively. */
const SNAPSHOT_DIRS = ["leaves"] as const;
/** Filename for the persisted page->leaves diff inside a snapshot. */
const PAGE_REFS_FILE = "page-refs.json";
/** Sibling directory (relative to the data dir) that holds snapshots. */
const SNAPSHOTS_DIRNAME = "v3-snapshots";
/** Maximum number of snapshots to retain; older ones are pruned. */
const MAX_RETAINED_SNAPSHOTS = 5;

function snapshotsRoot(dataDir: string): string {
  return path.join(path.dirname(dataDir), SNAPSHOTS_DIRNAME);
}

async function copyFileIfExists(src: string, dest: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/** Copy `src` into `dest` recursively. Returns false if `src` doesn't exist. */
async function copyDirIfExists(src: string, dest: string): Promise<boolean> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(src, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  await fs.mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirIfExists(from, to);
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
    }
  }
  return true;
}

async function removeIfExists(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

function serializePageRefs(pageRefs: Map<string, string[]>): string {
  return JSON.stringify(Object.fromEntries(pageRefs), null, 2);
}

function deserializePageRefs(raw: string): Map<string, string[]> {
  const obj = JSON.parse(raw) as Record<string, string[]>;
  return new Map(Object.entries(obj));
}

/**
 * Copy the v3 data dir's durable state into a timestamped sibling snapshot
 * directory and return its path.
 *
 * @param dataDir Absolute path to the v3 data dir.
 * @param opts.pageRefs Optional slug->prior-leaves map describing page
 *   frontmatter that lives outside the data dir; persisted so a later restore
 *   can revert it.
 * @param opts.label Snapshot directory name. Defaults to `Date.now()`; pass an
 *   explicit label to keep tests deterministic.
 * @returns Absolute path to the created snapshot directory.
 */
export async function snapshotDataDir(
  dataDir: string,
  opts?: { pageRefs?: Map<string, string[]>; label?: string },
): Promise<string> {
  const label = opts?.label ?? String(Date.now());
  const snapshotPath = path.join(snapshotsRoot(dataDir), label);
  await fs.mkdir(snapshotPath, { recursive: true });

  for (const file of SNAPSHOT_FILES) {
    await copyFileIfExists(
      path.join(dataDir, file),
      path.join(snapshotPath, file),
    );
  }
  for (const dir of SNAPSHOT_DIRS) {
    await copyDirIfExists(
      path.join(dataDir, dir),
      path.join(snapshotPath, dir),
    );
  }
  if (opts?.pageRefs) {
    await fs.writeFile(
      path.join(snapshotPath, PAGE_REFS_FILE),
      serializePageRefs(opts.pageRefs),
    );
  }

  await pruneSnapshots(dataDir);
  return snapshotPath;
}

/**
 * Atomically replace the v3 data dir's durable state from a snapshot.
 *
 * Each captured file/dir is staged next to its destination and renamed into
 * place, so a crash mid-restore never leaves a half-copied tree.
 *
 * @param snapshotPath Absolute path to a directory created by
 *   {@link snapshotDataDir}.
 * @param dataDir Absolute path to the v3 data dir to overwrite.
 * @returns The persisted `pageRefs` map (if the snapshot captured one) so the
 *   caller can revert external page frontmatter.
 */
export async function restoreDataDir(
  snapshotPath: string,
  dataDir: string,
): Promise<{ pageRefs?: Map<string, string[]> }> {
  await fs.mkdir(dataDir, { recursive: true });

  for (const file of SNAPSHOT_FILES) {
    const src = path.join(snapshotPath, file);
    const dest = path.join(dataDir, file);
    const tmp = `${dest}.restore-tmp`;
    try {
      await fs.copyFile(src, tmp);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Snapshot didn't capture this file; drop any stale destination copy.
        await removeIfExists(dest);
        continue;
      }
      throw err;
    }
    await fs.rename(tmp, dest);
  }

  for (const dir of SNAPSHOT_DIRS) {
    const src = path.join(snapshotPath, dir);
    const dest = path.join(dataDir, dir);
    const tmp = `${dest}.restore-tmp`;
    await removeIfExists(tmp);
    const captured = await copyDirIfExists(src, tmp);
    if (!captured) {
      // Snapshot didn't capture this dir; drop any stale destination copy.
      await removeIfExists(dest);
      continue;
    }
    await removeIfExists(dest);
    await fs.rename(tmp, dest);
  }

  const pageRefsPath = path.join(snapshotPath, PAGE_REFS_FILE);
  try {
    const raw = await fs.readFile(pageRefsPath, "utf8");
    return { pageRefs: deserializePageRefs(raw) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Delete all but the most recent {@link MAX_RETAINED_SNAPSHOTS} snapshot
 * directories. Snapshots sort lexicographically by their label; numeric
 * timestamps and zero-padded labels both order chronologically.
 */
async function pruneSnapshots(dataDir: string): Promise<void> {
  const root = snapshotsRoot(dataDir);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const stale = dirs.slice(
    0,
    Math.max(0, dirs.length - MAX_RETAINED_SNAPSHOTS),
  );
  for (const name of stale) {
    await removeIfExists(path.join(root, name));
  }
}

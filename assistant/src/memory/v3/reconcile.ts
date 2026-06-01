/**
 * Memory v3 — deterministic tree reconciler.
 *
 * After a maintainer restructures the leaf tree on disk (renames a leaf, moves
 * it under a new domain, splits one leaf into several, or deletes a leaf), the
 * page→leaf assignment store (each page's `leaves:` frontmatter) and the
 * always-on `core.json` set still point at the OLD leaf paths. This module
 * reconciles those references against the CURRENT on-disk tree, diffing leaves
 * by their stable `id` so a rename is distinguishable from a delete+add:
 *
 *   - id in prev and current with a changed path  → RENAME/MOVE. Every page
 *     `leaves:` ref and every `core.json` entry pointing at the old path is
 *     rewritten to the new path. Assignments are preserved verbatim.
 *   - id in prev but absent from current          → DELETE. The deleted leaf's
 *     member pages are first RE-HOMED across the surviving tree via
 *     {@link assignPages} (union semantics — no page is left orphaned), then the
 *     dangling ref to the old path is dropped from page frontmatter and core.
 *   - id in current but absent from prev          → ADD. Nothing to migrate.
 *
 * Splits are expressed as a removed `from` leaf whose members re-home across the
 * remaining/new leaves. Pass `splits` to restrict a from-leaf's members to a
 * specific target set; otherwise a removed leaf's members re-home across the
 * whole surviving tree (the generic delete path).
 *
 * Fail-closed: the whole operation runs against a snapshot taken BEFORE any
 * mutation. After rewrites, the reconciler VALIDATES that no page `leaves:` ref
 * and no `core.json` entry points at a leaf path absent from the current tree.
 * If any dangling reference survives, it restores the data dir and reverts the
 * affected page frontmatter from the snapshot, then re-throws — leaving the
 * workspace exactly as it was before the call.
 *
 * On a successful reconcile it invalidates the v3 lanes ({@link invalidateLanes})
 * so the next turn rebuilds the tree/needle from the reconciled state.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { parse as parseYaml } from "yaml";

import type { Provider } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import { listPages, readPage, writePage } from "../v2/page-store.js";
import { assignPages } from "./assign.js";
import { loadCore } from "./core.js";
import { invalidateLanes } from "./shadow-plugin.js";
import { restoreDataDir, snapshotDataDir } from "./snapshot.js";
import { loadLeafTree } from "./tree.js";
import type { LeafPath, LeafTree, Slug } from "./types.js";

const log = getLogger("memory-v3-reconcile");

/** A leaf as seen at a point in time: its stable id (if any) and its path. */
export interface LeafRef {
  id?: string;
  path: LeafPath;
}

/**
 * Optional split directive: re-home `fromId`'s member pages across `toPaths`
 * only (instead of the whole surviving tree). `toPaths` must be leaf paths
 * present in the current tree.
 */
export interface SplitDirective {
  fromId: string;
  toPaths: LeafPath[];
}

export interface ReconcileArgs {
  /** The leaf set as it was BEFORE the maintainer's on-disk restructuring. */
  prevLeaves: LeafRef[];
  /** Absolute path to the v3 data dir (`<workspace>/memory/v3/data`). */
  dataDir: string;
  /** Workspace root; pages live under `<workspaceDir>/memory/concepts/`. */
  workspaceDir: string;
  /** Optional split directives (see {@link SplitDirective}). */
  splits?: SplitDirective[];
  /** Provider override forwarded to {@link assignPages} for re-homing. */
  provider?: Provider;
}

export interface ReconcileResult {
  /**
   * Continuity map for telemetry/eval: each entry maps a leaf's prior identity
   * (`id` when known, else its old path) to its new path. Renames record the
   * new path; deletes are omitted (the leaf has no new path).
   */
  idToNewPath: Map<string, LeafPath>;
  /** Leaf paths that were renamed/moved (old → new). */
  renames: Array<{ id?: string; oldPath: LeafPath; newPath: LeafPath }>;
  /** Leaf paths that were deleted (present in prev, absent from current). */
  deleted: LeafPath[];
  /** `core.json` entries pruned because they pointed outside the current tree. */
  prunedCore: LeafPath[];
}

// ---------------------------------------------------------------------------
// On-disk leaf reading (mirrors the parse approach in tree.ts; the helpers
// there are not exported, so we replicate the minimal slice we need here).
// ---------------------------------------------------------------------------

/** Recursively collect every `*.md` file under `dir`. */
async function collectMarkdownFiles(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

function parseLeafRef(yaml: string, leavesDir: string, file: string): LeafRef {
  const parsed = parseYaml(yaml) as unknown;
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`leaf ${file} frontmatter is not a mapping`);
  }
  const record = parsed as Record<string, unknown>;
  // Prefer the frontmatter `path`; fall back to the file location so a leaf with
  // a missing/empty path still resolves to its on-disk identity.
  const path =
    typeof record.path === "string" && record.path.length > 0
      ? record.path
      : relative(leavesDir, file).replace(/\.md$/, "").split(sep).join("/");
  return {
    path,
    ...(typeof record.id === "string" ? { id: record.id } : {}),
  };
}

/** Read the CURRENT leaf set (id + path) from `<dataDir>/leaves/**`. */
async function readCurrentLeaves(dataDir: string): Promise<LeafRef[]> {
  const leavesDir = join(dataDir, "leaves");
  const files = await collectMarkdownFiles(leavesDir);
  return Promise.all(
    files.map(async (file) => {
      const raw = await readFile(file, "utf8");
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(
        raw.replace(/^﻿/, ""),
      );
      if (!match) throw new Error(`leaf ${file} is missing YAML frontmatter`);
      return parseLeafRef(match[1], leavesDir, file);
    }),
  );
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

interface TreeDiff {
  /** old path → new path for leaves whose id persisted but path changed. */
  renames: Map<LeafPath, LeafPath>;
  /** leaves present in prev but absent from current (by id, or by path when no id). */
  deleted: LeafRef[];
}

/**
 * Diff `prev` against `current` BY id. Leaves without an id fall back to a
 * path-keyed comparison (legacy leaves predating stable ids): an id-less prev
 * leaf is "deleted" only if its path is absent from current.
 */
function diffByIdThenPath(prev: LeafRef[], current: LeafRef[]): TreeDiff {
  const currentById = new Map<string, LeafRef>();
  const currentPaths = new Set<LeafPath>();
  for (const leaf of current) {
    if (leaf.id) currentById.set(leaf.id, leaf);
    currentPaths.add(leaf.path);
  }

  const renames = new Map<LeafPath, LeafPath>();
  const deleted: LeafRef[] = [];

  for (const prevLeaf of prev) {
    if (prevLeaf.id) {
      const match = currentById.get(prevLeaf.id);
      if (!match) {
        deleted.push(prevLeaf);
      } else if (match.path !== prevLeaf.path) {
        renames.set(prevLeaf.path, match.path);
      }
      continue;
    }
    // No id: identity is the path. Deleted iff the path is gone.
    if (!currentPaths.has(prevLeaf.path)) deleted.push(prevLeaf);
  }

  return { renames, deleted };
}

// ---------------------------------------------------------------------------
// Page-frontmatter ref rewriting
// ---------------------------------------------------------------------------

/** Load every page's `leaves:` frontmatter as a slug → leaf-paths map. */
async function loadPageRefs(
  workspaceDir: string,
): Promise<Map<Slug, LeafPath[]>> {
  const slugs = await listPages(workspaceDir);
  const refs = new Map<Slug, LeafPath[]>();
  for (const slug of slugs) {
    const page = await readPage(workspaceDir, slug);
    if (page) refs.set(slug, page.frontmatter.leaves ?? []);
  }
  return refs;
}

/**
 * Apply a leaf-path transform to a single page's `leaves:` frontmatter and
 * persist it iff the result changed. `transform` returns the rewritten list
 * (renamed/dropped entries already applied), de-duplicated by the caller.
 */
async function rewritePageRefs(
  workspaceDir: string,
  slug: Slug,
  transform: (leaves: LeafPath[]) => LeafPath[],
): Promise<void> {
  const page = await readPage(workspaceDir, slug);
  if (!page) return;
  const before = page.frontmatter.leaves ?? [];
  const after = transform(before);
  if (sameLeaves(before, after)) return;
  await writePage(workspaceDir, {
    ...page,
    frontmatter: { ...page.frontmatter, leaves: after },
  });
}

function sameLeaves(a: LeafPath[], b: LeafPath[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** De-duplicate a leaf-path list, preserving first-seen order. */
function dedupe(leaves: LeafPath[]): LeafPath[] {
  const out: LeafPath[] = [];
  for (const leaf of leaves) if (!out.includes(leaf)) out.push(leaf);
  return out;
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/**
 * Reconcile page + core references against the current on-disk leaf tree.
 * See the module docstring for the full contract. Fail-closed: throws (after
 * restoring from snapshot) if any dangling reference survives validation.
 */
export async function reconcileTree(
  args: ReconcileArgs,
): Promise<ReconcileResult> {
  const { prevLeaves, dataDir, workspaceDir, splits, provider } = args;

  const current = await readCurrentLeaves(dataDir);
  const currentPaths = new Set<LeafPath>(current.map((l) => l.path));
  const { renames, deleted } = diffByIdThenPath(prevLeaves, current);

  // Capture the prior page->leaves map so a failed reconcile can revert the
  // external page frontmatter the same way the snapshot reverts the data dir.
  const priorPageRefs = await loadPageRefs(workspaceDir);
  const snapshotPath = await snapshotDataDir(dataDir, {
    pageRefs: priorPageRefs,
  });

  try {
    const result = await applyReconcile({
      current,
      currentPaths,
      renames,
      deleted,
      splits: splits ?? [],
      workspaceDir,
      dataDir,
      provider,
    });
    await validateNoDangling(workspaceDir, dataDir, currentPaths);
    invalidateLanes();
    return result;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "reconcile failed validation — restoring from snapshot",
    );
    await revertFromSnapshot(snapshotPath, dataDir, workspaceDir);
    throw err;
  }
}

interface ApplyArgs {
  current: LeafRef[];
  currentPaths: Set<LeafPath>;
  renames: Map<LeafPath, LeafPath>;
  deleted: LeafRef[];
  splits: SplitDirective[];
  workspaceDir: string;
  dataDir: string;
  provider?: Provider;
}

async function applyReconcile(args: ApplyArgs): Promise<ReconcileResult> {
  const {
    current,
    currentPaths,
    renames,
    deleted,
    splits,
    workspaceDir,
    dataDir,
    provider,
  } = args;

  // The set of leaf paths a ref may legitimately resolve to: the current tree
  // plus every rename TARGET (a renamed leaf's new path is in `current`, but we
  // include the map's values defensively). Any page ref or core entry that does
  // NOT resolve into this set is dangling and must converge to a valid state.
  const validPaths = new Set<LeafPath>(currentPaths);
  for (const newPath of renames.values()) validPaths.add(newPath);

  // A ref is "dangling" when, after rename resolution, it points outside the
  // current tree. This covers BOTH reconciler-driven deletes (leaves in `prev`
  // but not `current`) AND out-of-band deletes/renames a maintainer made on disk
  // without a `prevLeaves` entry — the v1 convergence/prune case. We drop such
  // refs in step 2; first (step 1) we re-home any page that would otherwise be
  // orphaned so no page is left with zero leaves.
  const isDangling = (resolved: LeafPath): boolean => !validPaths.has(resolved);

  // 1. Re-home members of dangling leaves BEFORE dropping any refs, so a page
  //    that would lose its only leaf gains a surviving one (no orphan). We
  //    re-home first, against the still-intact assignments, then drop the dead
  //    path. Reconciler-tracked deletes may carry a split directive; out-of-band
  //    dangling leaves (discovered from page refs) re-home across the whole tree.
  const splitById = new Map<string, SplitDirective>(
    splits.map((s) => [s.fromId, s]),
  );
  const slugs = await listPages(workspaceDir);

  // Collect every dangling leaf path: explicit deletes + any leaf referenced by
  // a page that resolves outside the current tree.
  const danglingLeafToMembers = new Map<LeafPath, Slug[]>();
  for (const leaf of deleted) danglingLeafToMembers.set(leaf.path, []);
  for (const slug of slugs) {
    const page = await readPage(workspaceDir, slug);
    if (!page) continue;
    for (const ref of page.frontmatter.leaves ?? []) {
      const resolved = renames.get(ref) ?? ref;
      if (!isDangling(resolved)) continue;
      const members = danglingLeafToMembers.get(ref) ?? [];
      members.push(slug);
      danglingLeafToMembers.set(ref, members);
    }
  }

  const deletedPaths = new Set<LeafPath>(danglingLeafToMembers.keys());
  for (const [leafPath, members] of danglingLeafToMembers) {
    if (members.length === 0) continue;
    const id = deleted.find((l) => l.path === leafPath)?.id;
    const split = id ? splitById.get(id) : undefined;
    await rehomeMembers(workspaceDir, dataDir, members, split, provider);
  }

  // 2. Rewrite renamed paths and drop dangling paths from page frontmatter.
  for (const slug of slugs) {
    await rewritePageRefs(workspaceDir, slug, (leaves) =>
      dedupe(
        leaves.map((p) => renames.get(p) ?? p).filter((p) => !isDangling(p)),
      ),
    );
  }

  // 3. Rewrite renamed paths, drop deleted paths, and PRUNE any core entry that
  //    points outside the current tree.
  const core = await loadCore(dataDir);
  const prunedCore: LeafPath[] = [];
  const nextCore: LeafPath[] = [];
  for (const path of core) {
    const renamed = renames.get(path);
    const resolved = renamed ?? path;
    if (deletedPaths.has(resolved) || !currentPaths.has(resolved)) {
      prunedCore.push(path);
      continue;
    }
    if (!nextCore.includes(resolved)) nextCore.push(resolved);
  }
  await writeCore(dataDir, nextCore);

  // 4. Build the continuity map (renames → new path; deletes have no new path).
  const idToNewPath = new Map<string, LeafPath>();
  const renameList: ReconcileResult["renames"] = [];
  for (const [oldPath, newPath] of renames) {
    const id = current.find((l) => l.path === newPath)?.id;
    renameList.push({ id, oldPath, newPath });
    idToNewPath.set(id ?? oldPath, newPath);
  }

  return {
    idToNewPath,
    renames: renameList,
    deleted: deleted.map((l) => l.path),
    prunedCore,
  };
}

/**
 * Re-home a deleted leaf's member pages onto the surviving tree via
 * {@link assignPages} (union semantics — never drops a page's other leaves).
 * When a {@link SplitDirective} is supplied, the classifier is restricted to a
 * sub-tree containing only the split's `toPaths` so members redistribute across
 * the explicit targets; otherwise it runs against the whole current tree.
 */
async function rehomeMembers(
  workspaceDir: string,
  dataDir: string,
  members: Slug[],
  split: SplitDirective | undefined,
  provider?: Provider,
): Promise<void> {
  const fullTree: LeafTree = await loadLeafTreeForReconcile(
    workspaceDir,
    dataDir,
  );
  const tree =
    split && split.toPaths.length > 0
      ? restrictTree(fullTree, split.toPaths)
      : fullTree;
  if (tree.leaves.size === 0) return;
  await assignPages({
    tree,
    workspaceDir,
    slugs: members,
    provider,
    throttleMs: 0,
  });
}

/** Load the current tree with page-frontmatter assignments folded in. */
async function loadLeafTreeForReconcile(
  workspaceDir: string,
  dataDir: string,
): Promise<LeafTree> {
  const pageRefs = await loadPageRefs(workspaceDir);
  return loadLeafTree(dataDir, pageRefs);
}

/** A view of `tree` containing only the leaves in `keep`. */
function restrictTree(tree: LeafTree, keep: LeafPath[]): LeafTree {
  const keepSet = new Set(keep);
  const leaves = new Map(
    [...tree.leaves].filter(([path]) => keepSet.has(path)),
  );
  return { leaves, byPage: tree.byPage };
}

/** Persist the always-on core set back to `<dataDir>/core.json`. */
async function writeCore(dataDir: string, alwaysOn: LeafPath[]): Promise<void> {
  await writeFile(
    join(dataDir, "core.json"),
    `${JSON.stringify({ alwaysOn }, null, 2)}\n`,
  );
}

/**
 * Fail-closed validation: after all rewrites, NO page `leaves:` ref and NO
 * core entry may point at a leaf path absent from the current tree. Throws on
 * the first dangling reference found.
 */
async function validateNoDangling(
  workspaceDir: string,
  dataDir: string,
  currentPaths: Set<LeafPath>,
): Promise<void> {
  const pageRefs = await loadPageRefs(workspaceDir);
  for (const [slug, leaves] of pageRefs) {
    for (const leaf of leaves) {
      if (!currentPaths.has(leaf)) {
        throw new Error(
          `reconcile validation failed: page "${slug}" references missing leaf "${leaf}"`,
        );
      }
    }
  }
  const core = await loadCore(dataDir);
  for (const leaf of core) {
    if (!currentPaths.has(leaf)) {
      throw new Error(
        `reconcile validation failed: core references missing leaf "${leaf}"`,
      );
    }
  }
}

/**
 * Restore the data dir from the snapshot AND revert external page frontmatter
 * from the snapshot's captured `pageRefs`, so a failed reconcile leaves the
 * workspace byte-for-byte as it was before the call.
 */
async function revertFromSnapshot(
  snapshotPath: string,
  dataDir: string,
  workspaceDir: string,
): Promise<void> {
  const { pageRefs } = await restoreDataDir(snapshotPath, dataDir);
  if (!pageRefs) return;
  for (const [slug, leaves] of pageRefs) {
    const page = await readPage(workspaceDir, slug);
    if (!page) continue;
    if (sameLeaves(page.frontmatter.leaves ?? [], leaves)) continue;
    await writePage(workspaceDir, {
      ...page,
      frontmatter: { ...page.frontmatter, leaves },
    });
  }
}

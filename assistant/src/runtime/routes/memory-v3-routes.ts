/**
 * Memory v3 route definitions — tree-gardening + core-editing operations for
 * the leaf-tree memory model.
 *
 * The daemon owns the live tree, so the *mutating* gardening verbs
 * (`reconcile`, `set-core --write`, `rebuild-index`) run here, inside the
 * daemon process, where the in-memory shadow lanes can be invalidated after a
 * write. The read-only `health` report and the `set-core` cost preview also
 * route through the daemon so it stays the single source of truth for the live
 * workspace tree.
 *
 * Each route's behavior lives in a small DI-friendly `handle*` function that
 * takes an optional `MemoryV3Deps` (filesystem overrides) so tests can drive it
 * against a temp workspace without mocking module globals. The exported
 * `RouteDefinition`s are thin `RouteHandlerArgs` adapters over those handlers.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadCore } from "../../memory/v3/core.js";
import { computeV3Health, renderV3Health } from "../../memory/v3/health.js";
import { type LeafRef, reconcileTree } from "../../memory/v3/reconcile.js";
import { invalidateLanes } from "../../memory/v3/shadow-plugin.js";
import {
  coreSlugs,
  loadLeafTree,
  resolveDataDir,
} from "../../memory/v3/tree.js";
import type { LeafPath, LeafTree, Slug } from "../../memory/v3/types.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { ACTOR_PRINCIPALS, type RoutePolicy } from "../auth/route-policy.js";
import { RouteError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("memory-v3-routes");

/**
 * Filesystem location overrides. Production callers omit these and the handlers
 * resolve the live workspace; tests inject a temp workspace + data dir to
 * exercise the handlers without mocking module globals.
 */
export interface MemoryV3Deps {
  dataDir?: string;
  workspaceDir?: string;
}

// ---------------------------------------------------------------------------
// Shared loading helpers
// ---------------------------------------------------------------------------

/** Load the live leaf tree + its full slug universe from the resolved data dir. */
async function loadTreeAndSlugs(deps?: MemoryV3Deps): Promise<{
  dataDir: string;
  tree: LeafTree;
  allSlugs: Slug[];
}> {
  const dataDir = deps?.dataDir ?? resolveDataDir();
  const tree = await loadLeafTree(dataDir);
  // The full slug universe is every page the tree knows about (its `byPage`
  // keys). A slug is "unassigned" when it maps to no leaf, so the universe must
  // include those slugs too — `byPage` carries them from assignments.json.
  const allSlugs = [...tree.byPage.keys()];
  return { dataDir, tree, allSlugs };
}

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

export interface MemoryV3HealthResult {
  /** Pre-rendered, human-readable report. Empty string when all-green. */
  rendered: string;
  /** The structural counts, for `--json` consumers. */
  counts: {
    unassigned: number;
    danglingRefs: number;
    novelClusters: number;
    oversizedLeaves: number;
    tinyLeaves: number;
  };
}

export async function handleMemoryV3Health(
  deps?: MemoryV3Deps,
): Promise<MemoryV3HealthResult> {
  const { dataDir, tree, allSlugs } = await loadTreeAndSlugs(deps);
  const core = await loadCore(dataDir);
  const report = computeV3Health({ tree, allSlugs, core });
  return {
    rendered: renderV3Health(report),
    counts: {
      unassigned: report.unassigned.length,
      danglingRefs: report.danglingRefs.length,
      novelClusters: report.novelClusters.length,
      oversizedLeaves: report.oversizedLeaves.length,
      tinyLeaves: report.tinyLeaves.length,
    },
  };
}

// ---------------------------------------------------------------------------
// set-core
// ---------------------------------------------------------------------------

export interface MemoryV3SetCoreBody {
  /** Leaves to add to the always-on core set. */
  add?: LeafPath[];
  /** Leaves to remove from the always-on core set. */
  remove?: LeafPath[];
  /**
   * When true, persist the new core to `core.json` and invalidate the lanes.
   * When false (default), compute the preview WITHOUT writing.
   */
  write?: boolean;
}

export interface MemoryV3SetCoreResult {
  /** The core leaf set that would result (or did result, when `write`). */
  nextCore: LeafPath[];
  /** Number of unique page slugs the new core set pins always-on. */
  alwaysOnPageCount: number;
  /** Whether `core.json` was written. */
  written: boolean;
}

/** Wire-format error code for a `set-core` add referencing an unknown leaf. */
export const MEMORY_V3_UNKNOWN_LEAF_CODE = "MEMORY_V3_UNKNOWN_LEAF";

/** Thrown when a `set-core` add entry does not exist in the live tree. */
export class UnknownLeafError extends Error {
  constructor(public readonly unknown: LeafPath[]) {
    super(
      `Unknown leaf path(s) — not present in the tree: ${unknown.join(", ")}`,
    );
    this.name = "UnknownLeafError";
  }
}

/** Persist the always-on core set back to `<dataDir>/core.json`. */
async function writeCore(dataDir: string, alwaysOn: LeafPath[]): Promise<void> {
  await writeFile(
    join(dataDir, "core.json"),
    `${JSON.stringify({ alwaysOn }, null, 2)}\n`,
  );
}

export async function handleMemoryV3SetCore(
  body: MemoryV3SetCoreBody,
  deps?: MemoryV3Deps,
): Promise<MemoryV3SetCoreResult> {
  const add = body.add ?? [];
  const remove = body.remove ?? [];
  const { dataDir, tree } = await loadTreeAndSlugs(deps);

  // Validate every ADD entry exists in the live tree. Removing an entry that is
  // already absent is a no-op (idempotent), so only adds are validated.
  const unknown = add.filter((leaf) => !tree.leaves.has(leaf));
  if (unknown.length > 0) throw new UnknownLeafError(unknown);

  const core = await loadCore(dataDir);
  for (const leaf of remove) core.delete(leaf);
  for (const leaf of add) core.add(leaf);

  // Drop any pre-existing core entry that no longer maps to a live leaf, so the
  // preview reflects what the tree can actually pin. Sorted for stable output.
  const nextCore = [...core].filter((leaf) => tree.leaves.has(leaf)).sort();
  const nextCoreSet = new Set<LeafPath>(nextCore);

  // Cost preview: the number of UNIQUE page slugs the new core pins always-on.
  const alwaysOnPageCount = coreSlugs(tree, nextCoreSet).size;

  if (body.write === true) {
    await writeCore(dataDir, nextCore);
    invalidateLanes();
    log.info(
      { coreSize: nextCore.length, alwaysOnPageCount },
      "memory-v3 core updated",
    );
  }

  return { nextCore, alwaysOnPageCount, written: body.write === true };
}

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

export interface MemoryV3ReconcileResult {
  renames: Array<{ id?: string; oldPath: LeafPath; newPath: LeafPath }>;
  deleted: LeafPath[];
  prunedCore: LeafPath[];
}

/**
 * Reconcile page + core references against the live on-disk tree.
 *
 * `prevLeaves` describes the tree as it was BEFORE the maintainer's on-disk
 * restructuring. We derive it from the current leaf set, which makes reconcile
 * a safe convergence pass: renames/deletes already applied on disk diff to
 * nothing, while it still rewrites any page/core ref left dangling and prunes
 * stale core entries (and fail-closed restores on a residual dangling ref).
 * `reconcileTree` snapshots, applies, validates, and invalidates the lanes.
 */
export async function handleMemoryV3Reconcile(
  deps?: MemoryV3Deps,
): Promise<MemoryV3ReconcileResult> {
  const workspaceDir = deps?.workspaceDir ?? getWorkspaceDir();
  const dataDir = deps?.dataDir ?? resolveDataDir();
  const prevLeaves = await loadPrevLeaves(dataDir);

  const result = await reconcileTree({ prevLeaves, dataDir, workspaceDir });
  return {
    renames: result.renames,
    deleted: result.deleted,
    prunedCore: result.prunedCore,
  };
}

/** The current leaf set as `LeafRef`s (path + stable id when present). */
async function loadPrevLeaves(dataDir: string): Promise<LeafRef[]> {
  const tree = await loadLeafTree(dataDir);
  return [...tree.leaves.values()].map((node) => ({
    path: node.path,
    ...(node.frontmatter.id ? { id: node.frontmatter.id } : {}),
  }));
}

// ---------------------------------------------------------------------------
// rebuild-index
// ---------------------------------------------------------------------------

export interface MemoryV3RebuildIndexResult {
  ok: true;
}

/**
 * Invalidate the v3 shadow lanes so the next turn rebuilds the tree/needle
 * from the current on-disk state. Runs in-daemon so it acts on the live
 * process's cached lanes (an in-CLI call would invalidate nothing).
 */
export async function handleMemoryV3RebuildIndex(): Promise<MemoryV3RebuildIndexResult> {
  invalidateLanes();
  log.info("memory-v3 lanes invalidated (rebuild-index)");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Route definitions (RouteHandlerArgs adapters over the handlers above)
// ---------------------------------------------------------------------------

const POLICY: RoutePolicy = {
  requiredScopes: ["settings.read"],
  allowedPrincipalTypes: ACTOR_PRINCIPALS,
};

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "memory_v3_health",
    method: "POST",
    policy: POLICY,
    endpoint: "memory/v3/health",
    handler: () => handleMemoryV3Health(),
    summary: "Print the v3 structural health report (read-only)",
    tags: ["memory"],
  },
  {
    operationId: "memory_v3_set_core",
    method: "POST",
    policy: POLICY,
    endpoint: "memory/v3/set-core",
    handler: async ({ body = {} }: RouteHandlerArgs) => {
      try {
        return await handleMemoryV3SetCore(body as MemoryV3SetCoreBody);
      } catch (err) {
        if (err instanceof UnknownLeafError) {
          throw new RouteError(err.message, MEMORY_V3_UNKNOWN_LEAF_CODE, 422);
        }
        throw err;
      }
    },
    summary: "Add/remove always-on core leaves (validates + previews cost)",
    tags: ["memory"],
  },
  {
    operationId: "memory_v3_reconcile",
    method: "POST",
    policy: POLICY,
    endpoint: "memory/v3/reconcile",
    handler: () => handleMemoryV3Reconcile(),
    summary: "Reconcile page/core refs against the current on-disk leaf tree",
    tags: ["memory"],
  },
  {
    operationId: "memory_v3_rebuild_index",
    method: "POST",
    policy: POLICY,
    endpoint: "memory/v3/rebuild-index",
    handler: () => handleMemoryV3RebuildIndex(),
    summary: "Invalidate the v3 lanes so the next turn rebuilds",
    tags: ["memory"],
  },
];

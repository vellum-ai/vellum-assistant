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

import { z } from "zod";

import { getPageIndex } from "../../memory/v2/page-index.js";
import { loadCore } from "../../plugins/defaults/memory-v3-shadow/core.js";
import {
  computeV3Health,
  renderV3Health,
} from "../../plugins/defaults/memory-v3-shadow/health.js";
import {
  type LeafRef,
  reconcileTree,
} from "../../plugins/defaults/memory-v3-shadow/reconcile.js";
import { invalidateLanes } from "../../plugins/defaults/memory-v3-shadow/shadow-plugin.js";
import {
  coreSlugs,
  loadLeafTree,
  resolveDataDir,
} from "../../plugins/defaults/memory-v3-shadow/tree.js";
import type {
  LeafPath,
  LeafTree,
  Slug,
} from "../../plugins/defaults/memory-v3-shadow/types.js";
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

/**
 * Load the live leaf tree + its full slug universe.
 *
 * Page `leaves:` frontmatter is the authoritative source of page→leaf
 * membership: we build a `pageLeaves` map from the page index and union it over
 * `assignments.json` via `loadLeafTree(dataDir, pageLeaves)`, and derive the
 * slug universe (`allSlugs`) from the page index itself. This mirrors
 * `maybePrependV3Health` in `memory/v2/consolidation-job.ts` so the CLI
 * `health` / `set-core` cost computations agree with the consolidation-injected
 * health block instead of disagreeing by reading stale assignments.json only.
 */
async function loadTreeAndSlugs(deps?: MemoryV3Deps): Promise<{
  dataDir: string;
  tree: LeafTree;
  allSlugs: Slug[];
}> {
  const workspaceDir = deps?.workspaceDir ?? getWorkspaceDir();
  const dataDir = deps?.dataDir ?? resolveDataDir();

  // Each page contributes its `leaves:` frontmatter as the authoritative leaf
  // set for that slug; the slug universe is every page the index knows about.
  const pageIndex = await getPageIndex(workspaceDir);
  const pageLeaves = new Map<Slug, LeafPath[]>();
  const allSlugs: Slug[] = [];
  for (const entry of pageIndex.entries) {
    pageLeaves.set(entry.slug, entry.leaves);
    allSlugs.push(entry.slug);
  }

  const tree = await loadLeafTree(dataDir, pageLeaves);
  return { dataDir, tree, allSlugs };
}

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

const MemoryV3HealthResultSchema = z.object({
  /** Pre-rendered, human-readable report. Empty string when all-green. */
  rendered: z.string(),
  /** The structural counts, for `--json` consumers. */
  counts: z.object({
    unassigned: z.number(),
    danglingRefs: z.number(),
    novelClusters: z.number(),
    oversizedLeaves: z.number(),
    tinyLeaves: z.number(),
  }),
});
export type MemoryV3HealthResult = z.infer<typeof MemoryV3HealthResultSchema>;

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

const MemoryV3SetCoreBodySchema = z.object({
  /** Leaves to add to the always-on core set. */
  add: z.array(z.string()).optional(),
  /** Leaves to remove from the always-on core set. */
  remove: z.array(z.string()).optional(),
  /**
   * When true, persist the new core to `core.json` and invalidate the lanes.
   * When false (default), compute the preview WITHOUT writing.
   */
  write: z.boolean().optional(),
});
export type MemoryV3SetCoreBody = z.infer<typeof MemoryV3SetCoreBodySchema>;

const MemoryV3SetCoreResultSchema = z.object({
  /** The core leaf set that would result (or did result, when `write`). */
  nextCore: z.array(z.string()),
  /** Number of unique page slugs the new core set pins always-on. */
  alwaysOnPageCount: z.number(),
  /** Whether `core.json` was written. */
  written: z.boolean(),
});
export type MemoryV3SetCoreResult = z.infer<typeof MemoryV3SetCoreResultSchema>;

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

const MemoryV3ReconcileResultSchema = z.object({
  renames: z.array(
    z.object({
      id: z.string().optional(),
      oldPath: z.string(),
      newPath: z.string(),
    }),
  ),
  deleted: z.array(z.string()),
  prunedCore: z.array(z.string()),
});
export type MemoryV3ReconcileResult = z.infer<
  typeof MemoryV3ReconcileResultSchema
>;

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
  // v1: prev == current is intentional. Without a captured prior leaf snapshot
  // we cannot detect renames/moves/splits, so this runs as a convergence /
  // dangling-ref prune pass. Full rename detection is a follow-up.
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

const MemoryV3RebuildIndexResultSchema = z.object({
  ok: z.literal(true),
});
export type MemoryV3RebuildIndexResult = z.infer<
  typeof MemoryV3RebuildIndexResultSchema
>;

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

/** Read-only verbs (the `health` report) require only `settings.read`. */
const READ_POLICY: RoutePolicy = {
  requiredScopes: ["settings.read"],
  allowedPrincipalTypes: ACTOR_PRINCIPALS,
};

/**
 * Mutating verbs require `settings.write`. `set-core --write`, `reconcile`, and
 * `rebuild-index` write `core.json`, rewrite page frontmatter, and invalidate
 * the live lanes, so a `settings.read`-only principal must not reach them.
 * (`set-core` without `write` is a preview, but it shares this route, so the
 * route as a whole is gated on write.)
 */
const WRITE_POLICY: RoutePolicy = {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ACTOR_PRINCIPALS,
};

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "memory_v3_health",
    method: "POST",
    policy: READ_POLICY,
    endpoint: "memory/v3/health",
    handler: () => handleMemoryV3Health(),
    summary: "Print the v3 structural health report (read-only)",
    tags: ["memory"],
    responseBody: MemoryV3HealthResultSchema,
  },
  {
    operationId: "memory_v3_set_core",
    method: "POST",
    policy: WRITE_POLICY,
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
    requestBody: MemoryV3SetCoreBodySchema,
    responseBody: MemoryV3SetCoreResultSchema,
  },
  {
    operationId: "memory_v3_reconcile",
    method: "POST",
    policy: WRITE_POLICY,
    endpoint: "memory/v3/reconcile",
    handler: () => handleMemoryV3Reconcile(),
    summary:
      "v1 convergence/prune pass over page+core refs (no rename detection without a prior snapshot)",
    tags: ["memory"],
    responseBody: MemoryV3ReconcileResultSchema,
  },
  {
    operationId: "memory_v3_rebuild_index",
    method: "POST",
    policy: WRITE_POLICY,
    endpoint: "memory/v3/rebuild-index",
    handler: () => handleMemoryV3RebuildIndex(),
    summary: "Invalidate the v3 lanes so the next turn rebuilds",
    tags: ["memory"],
    responseBody: MemoryV3RebuildIndexResultSchema,
  },
];

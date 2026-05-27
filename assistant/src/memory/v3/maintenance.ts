/**
 * Memory v3 — `memory_v3_index_maintenance` job + DAG-edit guards.
 *
 * The fast-lane, **no-LLM** mechanical counterpart to consolidation. Where
 * consolidation (the slow lane) asks the agent to author the tree, maintenance
 * is the deterministic upkeep that runs as a follow-up: it validates the tree,
 * surfaces stale composed indices, and cycle-checks the DAG so a consolidation
 * pass can't leave a loop behind.
 *
 * Three pieces:
 *   - {@link runIndexMaintenance} — the job body. Runs {@link validateTree}
 *     (merged: dangling refs, orphan pages, cycles, stale indices, unknown edge
 *     targets), logs a structured report, and returns a compact summary so the
 *     job dispatcher / tests can assert on it.
 *   - {@link wouldIntroduceCycle} — the guard a DAG editor calls BEFORE adding a
 *     `node:<child>` edge to a parent. Returns true when `child` already reaches
 *     `parent` by descending `node:` children (so adding the edge would close a
 *     loop). Uses the same iterative visited/guard traversal as the validator's
 *     descent so consolidation can refuse a cycle-introducing edit cheaply.
 *
 * Why no separate "refresh stale composed indices" write step: v3 node indices
 * are **composed at read time** (`index-composition.ts` is a pure function over
 * the live tree + page indices), so there is no persisted index to rewrite. The
 * maintenance job's job is to *detect and report* stale indices (a node whose
 * mtime predates a child it composes) — the re-authoring of the node's
 * self-description is the consolidation agent's responsibility, surfaced here so
 * the next pass knows what to refresh.
 */

import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import type { MemoryJob } from "../jobs-store.js";
import type { TreeIndex } from "./tree-index.js";
import { type TreeValidationReport, validateTree } from "./validate.js";

const log = getLogger("memory-v3-index-maintenance");

/**
 * Compact summary of an index-maintenance pass. Mirrors the `*Count` fields of
 * {@link TreeValidationReport} so callers (and the job dispatcher's log line)
 * can report the health of the tree without re-counting. `report` carries the
 * full per-id lists for anything that wants to act on the specifics.
 */
export interface IndexMaintenanceResult {
  danglingChildRefCount: number;
  orphanPageCount: number;
  cycleCount: number;
  staleIndexCount: number;
  unknownEdgeTargetCount: number;
  report: TreeValidationReport;
}

/**
 * Run a mechanical index-maintenance pass over the v3 tree.
 *
 * Validates the hand-authored tree (dangling refs, orphan pages, cycles, stale
 * composed indices, unknown edge targets) and logs a structured report. Stale
 * indices and cycles are warned at WARN so operators see structural drift a
 * consolidation pass introduced; the rest log at INFO. Never throws — like the
 * validator it wraps, this is a report, not an assertion. Returns the summary
 * so the job dispatcher and tests can assert on the counts.
 */
export async function runIndexMaintenance(
  workspaceDir = getWorkspaceDir(),
): Promise<IndexMaintenanceResult> {
  const report = await validateTree(workspaceDir);

  const result: IndexMaintenanceResult = {
    danglingChildRefCount: report.danglingChildRefCount,
    orphanPageCount: report.orphanPageCount,
    cycleCount: report.cycleCount,
    staleIndexCount: report.staleIndexCount,
    unknownEdgeTargetCount: report.unknownEdgeTargetCount,
    report,
  };

  const summaryFields = {
    danglingChildRefs: report.danglingChildRefCount,
    orphanPages: report.orphanPageCount,
    cycles: report.cycleCount,
    staleIndices: report.staleIndexCount,
    unknownEdgeTargets: report.unknownEdgeTargetCount,
  };

  if (report.cycleCount > 0 || report.staleIndexCount > 0) {
    log.warn(
      { ...summaryFields, cyclesDetail: report.cycles },
      "v3 index maintenance: structural drift detected (cycles and/or stale composed indices)",
    );
  } else {
    log.info(summaryFields, "v3 index maintenance complete");
  }

  return result;
}

/**
 * Job handler for `memory_v3_index_maintenance`. Thin wrapper over
 * {@link runIndexMaintenance} so the heavy lifting (and its tests) live in one
 * place. The job carries no payload — it always validates the whole tree.
 */
export async function memoryV3IndexMaintenanceJob(
  _job: MemoryJob,
): Promise<IndexMaintenanceResult> {
  return runIndexMaintenance();
}

/**
 * True when adding a `node:<child>` edge to `parent` would close a cycle —
 * i.e. `child` can already reach `parent` by descending `node:` children
 * (directly or transitively), or `child === parent` (a self-edge).
 *
 * The DAG editor (consolidation, edge-learning) calls this BEFORE writing a new
 * `node:` child so it can refuse the edit rather than leaving the validator to
 * report the loop after the fact. The walk reuses the same iterative
 * visited-guard descent the validator uses, so it terminates on existing cycles
 * (a pre-existing loop in the tree never makes this hang).
 *
 * `page:` children are never traversed (pages are leaves), so this only
 * considers the `node:` adjacency that actually forms the DAG.
 */
export function wouldIntroduceCycle(
  tree: TreeIndex,
  parent: string,
  child: string,
): boolean {
  if (parent === child) return true;

  // Walk down from `child` over `node:` children; if we ever reach `parent`,
  // the proposed `parent → child` edge would close a loop. `visited` guards
  // against pre-existing cycles so this terminates regardless of tree state.
  const visited = new Set<string>();
  const stack: string[] = [child];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === parent) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const ref of tree.childrenByNode.get(current) ?? []) {
      if (ref.kind === "node") stack.push(ref.ref);
    }
  }
  return false;
}

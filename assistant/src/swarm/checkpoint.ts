import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getRootDir } from "../util/platform.js";
import type { SwarmPlan, SwarmTaskResult } from "./types.js";

const log = getLogger("swarm-checkpoint");

/** Only allow safe token characters in runId (alphanumeric, hyphens, underscores, dots). */
const SAFE_RUN_ID = /^[a-zA-Z0-9._-]+$/;

function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) {
    throw new Error(
      `Invalid runId: must match ${SAFE_RUN_ID} (got "${runId}")`,
    );
  }
}

export interface SwarmCheckpoint {
  runId: string;
  objective: string;
  /** Serialized plan for integrity verification on resume. */
  planTaskIds: string[];
  /** Stringified task dependency map for structural integrity on resume. */
  planHash: string;
  results: SwarmTaskResult[];
  /** Set of task IDs whose dependents were blocked due to failure. */
  blockedTaskIds: string[];
  updatedAt: string;
}

function getCheckpointDir(): string {
  return join(getRootDir(), "swarm-checkpoints");
}

function getCheckpointPath(runId: string): string {
  assertSafeRunId(runId);
  return join(getCheckpointDir(), `${runId}.json`);
}

/**
 * Deterministic fingerprint of a plan's structure: objective, task IDs,
 * roles, and dependency edges. Two plans with the same hash are structurally
 * identical and safe to resume from.
 */
function computePlanHash(plan: SwarmPlan): string {
  const parts = plan.tasks.map(
    (t) => `${t.id}:${t.role}:${[...t.dependencies].sort().join(",")}`,
  );
  return `${plan.objective}|${parts.sort().join("|")}`;
}

/** Persist the current swarm progress to disk. */
export function writeCheckpoint(
  runId: string,
  plan: SwarmPlan,
  results: Map<string, SwarmTaskResult>,
  blockedTaskIds: Set<string>,
): void {
  try {
    const path = getCheckpointPath(runId);
    const checkpoint: SwarmCheckpoint = {
      runId,
      objective: plan.objective,
      planTaskIds: plan.tasks.map((t) => t.id),
      planHash: computePlanHash(plan),
      results: Array.from(results.values()),
      blockedTaskIds: Array.from(blockedTaskIds),
      updatedAt: new Date().toISOString(),
    };

    mkdirSync(dirname(path), { recursive: true });
    // Atomic-ish write: write to temp then rename to avoid partial reads
    const tmpPath = path + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(checkpoint, null, 2) + "\n");
    renameSync(tmpPath, path);
  } catch (err) {
    // Checkpoint failures should not crash the orchestrator
    log.warn(
      { runId, error: (err as Error).message },
      "Failed to write checkpoint",
    );
  }
}

/** Load a checkpoint from disk, or null if none exists. */
export function loadCheckpoint(runId: string): SwarmCheckpoint | null {
  const path = getCheckpointPath(runId);
  if (!existsSync(path)) return null;

  try {
    const data = readFileSync(path, "utf-8");
    return JSON.parse(data) as SwarmCheckpoint;
  } catch (err) {
    log.warn(
      { runId, error: (err as Error).message },
      "Failed to read checkpoint, starting fresh",
    );
    return null;
  }
}

/** Remove a checkpoint file after successful completion. */
export function removeCheckpoint(runId: string): void {
  const path = getCheckpointPath(runId);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Validate that a checkpoint matches the current plan.
 * Compares objective, task IDs, roles, and dependency structure via planHash.
 * Falls back to subset check for checkpoints written before planHash existed.
 */
export function isCheckpointCompatible(
  checkpoint: SwarmCheckpoint,
  plan: SwarmPlan,
): boolean {
  if (checkpoint.planHash) {
    return checkpoint.planHash === computePlanHash(plan);
  }
  // Legacy checkpoint without planHash — fall back to subset check
  const planTaskIds = new Set(plan.tasks.map((t) => t.id));
  return checkpoint.planTaskIds.every((id) => planTaskIds.has(id));
}

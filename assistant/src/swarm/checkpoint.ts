import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getRootDir } from '../util/platform.js';
import type { SwarmTaskResult, SwarmPlan } from './types.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('swarm-checkpoint');

export interface SwarmCheckpoint {
  runId: string;
  objective: string;
  /** Serialized plan for integrity verification on resume. */
  planTaskIds: string[];
  results: SwarmTaskResult[];
  /** Set of task IDs whose dependents were blocked due to failure. */
  blockedTaskIds: string[];
  updatedAt: string;
}

function getCheckpointDir(): string {
  return join(getRootDir(), 'swarm-checkpoints');
}

function getCheckpointPath(runId: string): string {
  return join(getCheckpointDir(), `${runId}.json`);
}

/** Persist the current swarm progress to disk. */
export function writeCheckpoint(
  runId: string,
  plan: SwarmPlan,
  results: Map<string, SwarmTaskResult>,
  blockedTaskIds: Set<string>,
): void {
  const path = getCheckpointPath(runId);
  const checkpoint: SwarmCheckpoint = {
    runId,
    objective: plan.objective,
    planTaskIds: plan.tasks.map((t) => t.id),
    results: Array.from(results.values()),
    blockedTaskIds: Array.from(blockedTaskIds),
    updatedAt: new Date().toISOString(),
  };

  try {
    mkdirSync(dirname(path), { recursive: true });
    // Atomic-ish write: write to temp then rename to avoid partial reads
    const tmpPath = path + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(checkpoint, null, 2) + '\n');
    renameSync(tmpPath, path);
  } catch (err) {
    // Checkpoint failures should not crash the orchestrator
    log.warn({ runId, error: (err as Error).message }, 'Failed to write checkpoint');
  }
}

/** Load a checkpoint from disk, or null if none exists. */
export function loadCheckpoint(runId: string): SwarmCheckpoint | null {
  const path = getCheckpointPath(runId);
  if (!existsSync(path)) return null;

  try {
    const data = readFileSync(path, 'utf-8');
    return JSON.parse(data) as SwarmCheckpoint;
  } catch (err) {
    log.warn({ runId, error: (err as Error).message }, 'Failed to read checkpoint, starting fresh');
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
 * Returns true if the checkpoint's task IDs are a subset of the plan's task IDs.
 */
export function isCheckpointCompatible(checkpoint: SwarmCheckpoint, plan: SwarmPlan): boolean {
  const planTaskIds = new Set(plan.tasks.map((t) => t.id));
  return checkpoint.planTaskIds.every((id) => planTaskIds.has(id));
}

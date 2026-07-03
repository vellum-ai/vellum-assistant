/**
 * Bun memory tuning for background worker subprocesses (memory jobs worker,
 * schedule worker, resource monitor, embed/rerank workers).
 *
 * JavaScriptCore calibrates its heap-growth heuristics from perceived machine
 * RAM. Under gVisor the cgroup limit files report the host node's memory
 * rather than the container's (the same discrepancy that motivates
 * VELLUM_MEMORY_LIMIT — see cgroup-memory.ts), so an unhinted worker grows its
 * heap as if it owned the whole node. `BUN_JSC_forceRAMSize` pins the
 * heuristic to a fraction of the actual container limit instead.
 *
 * The hint is a soft target, not a hard cap: a job that needs more memory
 * still gets it, at the cost of heavier GC pressure near the target. Workers
 * are latency-insensitive background processes, so the GC-throughput trade is
 * acceptable — the same reasoning behind spawning them with `--smol`.
 */

import { totalmem } from "node:os";

import { getContainerMemoryLimitBytes } from "./cgroup-memory.js";

const MIB = 1024 * 1024;

/**
 * Fraction of the container memory limit a single worker's heap heuristic
 * targets. The container budget is shared with the daemon (the largest
 * resident), the gateway, and transient tool subprocesses, so one background
 * worker gets a quarter.
 */
const WORKER_RAM_FRACTION = 0.25;

/**
 * Lower clamp: the memory jobs worker runs full background agent
 * conversations in-process, so a target below this forces constant GC without
 * fitting the workload anyway.
 */
export const WORKER_FORCE_RAM_MIN_BYTES = 512 * MIB;

/**
 * Upper clamp: past this, a bigger heap target only delays collection of
 * garbage the worker will never reuse, regardless of how large the machine is.
 */
export const WORKER_FORCE_RAM_MAX_BYTES = 2048 * MIB;

/**
 * RAM-size hint for a background worker, derived from the container memory
 * limit (host total memory when no container limit applies, e.g. local dev),
 * clamped to [{@link WORKER_FORCE_RAM_MIN_BYTES}, {@link WORKER_FORCE_RAM_MAX_BYTES}].
 */
export function computeWorkerForceRamSizeBytes(
  limitBytes: number | null = getContainerMemoryLimitBytes(),
): number {
  const base = limitBytes ?? totalmem();
  const target = Math.floor(base * WORKER_RAM_FRACTION);
  return Math.min(
    WORKER_FORCE_RAM_MAX_BYTES,
    Math.max(WORKER_FORCE_RAM_MIN_BYTES, target),
  );
}

/**
 * Environment for spawning a background worker `bun` process: the parent
 * environment plus `BUN_JSC_forceRAMSize`. An operator-provided
 * `BUN_JSC_forceRAMSize` in the parent environment wins over the computed
 * value.
 *
 * Bun.spawn replaces (rather than merges) the child environment when `env` is
 * passed, so this spreads the full parent environment.
 */
export function workerMemoryEnv(
  parentEnv: Record<string, string | undefined> = process.env,
  limitBytes: number | null = getContainerMemoryLimitBytes(),
): Record<string, string | undefined> {
  return {
    ...parentEnv,
    BUN_JSC_forceRAMSize:
      parentEnv.BUN_JSC_forceRAMSize ??
      String(computeWorkerForceRamSizeBytes(limitBytes)),
  };
}

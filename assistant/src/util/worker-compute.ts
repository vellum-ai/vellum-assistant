/**
 * ONNX Runtime thread tuning for the local ML worker subprocesses (embed,
 * rerank).
 *
 * ONNX Runtime sizes its intra-op thread pool from the machine's physical core
 * count when nothing says otherwise. An unhinted worker therefore takes every
 * core for the duration of an inference batch. On a developer laptop that pins
 * the machine and spins the fans; in a container it oversubscribes a CPU quota
 * the scheduler then throttles.
 *
 * The work is background indexing the user neither initiated nor can see, so
 * it should not preempt foreground work. Capping the pool trades batch latency
 * for leaving the rest of the system responsive, the same trade as spawning
 * these workers with `--smol`.
 *
 * Unlike the memory hint in worker-memory.ts, this is a hard cap: ONNX will
 * not exceed the configured thread count.
 */

import { getContainerCpuCores } from "./cgroup-cpu.js";

/**
 * Environment variable carrying the computed cap to the worker script. The
 * worker is a standalone bun process that reads this and passes it to ONNX as
 * `session_options.intraOpNumThreads`.
 */
export const ONNX_INTRA_OP_THREADS_ENV = "VELLUM_ONNX_INTRA_OP_THREADS";

/**
 * Fraction of available cores one ML worker's intra-op pool may use. The
 * machine is shared with the daemon, the gateway, tool subprocesses, and
 * (because embed and rerank are separate processes) potentially a second ML
 * worker, so one of them gets a quarter.
 */
const WORKER_CPU_FRACTION = 0.25;

/**
 * Lower clamp. ONNX treats a non-positive thread count as "pick for me", which
 * is the unbounded default this module exists to prevent, so the floor is 1.
 */
export const WORKER_MIN_INTRA_OP_THREADS = 1;

/**
 * Upper clamp. Intra-op scaling for models this size flattens well before this
 * point; past it, extra threads add synchronization overhead and heat without
 * shortening the batch.
 */
export const WORKER_MAX_INTRA_OP_THREADS = 4;

/**
 * Intra-op thread cap for an ML worker, derived from the container CPU limit
 * (the visible core count when no container limit applies, e.g. local dev),
 * clamped to [{@link WORKER_MIN_INTRA_OP_THREADS}, {@link WORKER_MAX_INTRA_OP_THREADS}].
 *
 * A zero or negative core count means detection failed entirely; fall back to
 * the floor rather than handing ONNX a value it would read as "unbounded".
 */
export function computeWorkerIntraOpThreads(cores: number): number {
  if (!Number.isFinite(cores) || cores <= 0) {
    return WORKER_MIN_INTRA_OP_THREADS;
  }
  const target = Math.floor(cores * WORKER_CPU_FRACTION);
  return Math.min(
    WORKER_MAX_INTRA_OP_THREADS,
    Math.max(WORKER_MIN_INTRA_OP_THREADS, target),
  );
}

/**
 * Environment additions for spawning an ONNX worker: the intra-op thread cap.
 * An operator-provided value in the parent environment wins over the computed
 * one, matching how `workerMemoryEnv` treats `BUN_JSC_forceRAMSize`.
 *
 * Returns only the compute keys, so spread this over `workerMemoryEnv()`,
 * which carries the full parent environment.
 */
export function workerComputeEnv(): Record<string, string> {
  return {
    [ONNX_INTRA_OP_THREADS_ENV]:
      process.env[ONNX_INTRA_OP_THREADS_ENV] ??
      String(computeWorkerIntraOpThreads(getContainerCpuCores())),
  };
}

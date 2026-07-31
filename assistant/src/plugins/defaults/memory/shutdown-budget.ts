/**
 * How long the memory-worker process waits for the embedding backend to reap
 * the ONNX worker subprocess it owns before exiting anyway.
 *
 * Must exceed `WORKER_TEARDOWN_BUDGET_MS` in
 * `persistence/embeddings/embedding-local.ts` (the SIGTERM wait plus the
 * SIGKILL wait), or the process exits mid-reap and orphans the child.
 *
 * Duplicated rather than imported: the plugin-import boundary guard forbids the
 * memory plugin from reaching into `persistence/`, and re-exporting it through
 * `embedding-backend.ts` would force a static import of `embedding-local.ts`,
 * defeating the dynamic import that keeps onnxruntime-node off the daemon's
 * startup path in compiled binaries. `src/__tests__/worker-shutdown-budget.test.ts`
 * fails if the two drift apart.
 *
 * Kept in its own module so that test can read it without importing
 * `worker.ts`, whose module body starts the worker process.
 */
export const SHUTDOWN_REAP_BUDGET_MS = 5_000;

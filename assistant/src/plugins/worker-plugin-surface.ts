/**
 * Default-plugin surface for sidecar worker processes.
 *
 * Worker processes that run real agent conversations (the memory jobs worker,
 * the schedule worker) register the first-party default plugins' hooks and
 * runtime injectors so those conversations get the same hook-driven behavior as
 * conversations in the daemon: image captioning and vision-rejection recovery,
 * tool-result truncation, history repair, and the per-turn runtime injections.
 * Hook and injector dispatch is process-global, so one call at worker startup
 * covers every conversation that process runs.
 *
 * Plugin `init` hooks are deliberately not run here. Registration is pure
 * hook-table and injector-table population, and the default plugins degrade
 * gracefully without their init-owned state (the image-fallback caption cache
 * falls back to in-memory caching when its SQLite handle is absent). The memory
 * plugin's init must never run in a worker: it starts the memory jobs worker
 * process itself.
 */

import {
  registerDefaultPluginInjectors,
  registerDefaultPlugins,
} from "./defaults/index.js";

/**
 * Register the first-party default plugins' hooks and runtime injectors in the
 * current process. Both registration functions are idempotent, so repeat calls
 * are safe.
 */
export function registerWorkerPluginSurface(): void {
  registerDefaultPlugins();
  registerDefaultPluginInjectors();
}

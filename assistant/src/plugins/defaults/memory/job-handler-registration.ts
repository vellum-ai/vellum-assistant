/**
 * Register the memory plugin's own background-job handlers directly into the
 * worker's dispatch table.
 *
 * The memory plugin owns its handlers end-to-end: the init hook (daemon) and the
 * standalone worker process — the two callers that actually start the worker —
 * register them here rather than routing them through a generic plugin
 * job-handler registry. Keeping registration inside the plugin means the startup
 * path never has to reach back through the `plugins/defaults` barrel, which would
 * otherwise close an import cycle.
 */

import { registerJobHandler } from "../../../persistence/jobs-worker.js";
import { memoryJobHandlers } from "./job-handlers.js";

export function registerMemoryPluginJobHandlers(): void {
  for (const { type, handler } of memoryJobHandlers) {
    registerJobHandler(type, handler);
  }
}

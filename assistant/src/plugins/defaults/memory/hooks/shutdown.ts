/**
 * Memory plugin `shutdown` hook — stop the plugin's in-process jobs-worker
 * supervisor, the counterpart of the `init` hook's worker start (via
 * `runMemoryStartup`). Fires through the unified `runHook(HOOKS.SHUTDOWN)`
 * dispatch in the daemon's shutdown sequence, before transports and the DB
 * come down, so the worker stops claiming jobs while teardown proceeds.
 *
 * Only the in-process supervisor is stopped here: the out-of-process worker
 * is daemon-owned infrastructure (spawned/stopped by worker-control), and the
 * daemon shutdown handler signals it directly.
 */

import type { HookFunction, ShutdownContext } from "@vellumai/plugin-api";

import { stopMemoryJobsWorker } from "../jobs-worker.js";

const shutdown: HookFunction<ShutdownContext> = async () => {
  stopMemoryJobsWorker();
};

export default shutdown;

/**
 * Memory plugin `shutdown` hook — SIGTERM the memory jobs worker process, the
 * counterpart of the `init` hook's worker start (via `runMemoryStartup`). Fires
 * through the unified `runHook(HOOKS.SHUTDOWN)` dispatch in the daemon's
 * shutdown sequence, before transports and the DB come down, so the worker
 * stops claiming jobs while teardown proceeds. The daemon shutdown handler also
 * signals the worker directly; the stop is idempotent.
 */

import type { HookFunction, ShutdownContext } from "@vellumai/plugin-api";

import { stopMemoryWorkerProcess } from "../../../../persistence/worker-control.js";

const shutdown: HookFunction<ShutdownContext> = async () => {
  stopMemoryWorkerProcess();
};

export default shutdown;

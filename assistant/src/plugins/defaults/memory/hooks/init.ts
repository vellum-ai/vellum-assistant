/**
 * Memory plugin `init` hook — own the memory subsystem's boot end-to-end:
 * register its job handlers and kick off background startup (which starts the
 * jobs worker).
 *
 * The plugin registers its own handlers directly into the worker dispatch table
 * (rather than through a generic plugin registry) synchronously here, before
 * `runMemoryStartup` is kicked off — so registration is guaranteed to
 * happen-before the worker's first job claim (the worker is started near the end
 * of `runMemoryStartup`, after Qdrant is up). `runMemoryStartup` runs
 * fire-and-forget so the daemon keeps serving while memory warms up; each of its
 * steps contains its own failure.
 */

import type { HookFunction, InitContext } from "@vellumai/plugin-api";

import { getConfig } from "../../../../config/loader.js";
import { registerMemoryPluginJobHandlers } from "../job-handler-registration.js";
import { getLogger } from "../logging.js";
import { runMemoryStartup } from "../startup.js";

const log = getLogger("memory-init");

const init: HookFunction<InitContext> = async () => {
  // Register the job handlers directly into the worker dispatch table — the
  // memory plugin's own plus the host's non-plugin domain handlers.
  // Synchronous and first, so it happens-before the worker start inside
  // `runMemoryStartup` below — otherwise a queued job could be dispatched
  // against an empty table and failed as an unknown type.
  registerMemoryPluginJobHandlers();

  // Boot Qdrant, reconcile collections, and start the memory jobs worker in the
  // background so the daemon keeps accepting requests without waiting on it.
  // Fire-and-forget with a contained failure — a memory-subsystem problem must
  // never block boot.
  void runMemoryStartup(getConfig()).catch((err) =>
    log.warn({ err }, "Background memory startup failed"),
  );
};

export default init;

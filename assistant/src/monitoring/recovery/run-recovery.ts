/**
 * `runRecovery` — the monitor process's recovery orchestrator.
 *
 * Startup reconciliation that would otherwise weigh down the daemon's boot
 * path runs here instead, in the resource-monitor process, off the daemon's
 * event loop. It lists a set of recovery steps and runs each ONCE, shortly
 * after the monitor starts — this is crash recovery, not a periodic sweep.
 * Each step owns the database file it needs and its own logging; the
 * orchestrator only sequences them and isolates one step's failure from the
 * next.
 *
 * Steps run in order; new reconciliations plug in by adding a
 * {@link RecoveryStep} to `RECOVERY_STEPS`. `clear-stale-processing` runs
 * first because `inflight-content`'s "is this a live turn" guard reads the
 * `processing_started_at` state it resets.
 */

import { getLogger } from "../../util/logger.js";
import { recoverInflightContent } from "./inflight-content.js";
import { clearStaleProcessing } from "./stale-processing.js";

const log = getLogger("recovery");

/**
 * Delay before the one-shot recovery run, giving the daemon time to finish
 * migrations before recovery reads the schema.
 */
const RECOVERY_DELAY_MS = 15_000;

export interface RecoveryStep {
  readonly name: string;
  /** Reconcile once. Owns its own DB handle and logging; may throw. */
  run(): void;
}

const RECOVERY_STEPS: RecoveryStep[] = [
  { name: "clear-stale-processing", run: clearStaleProcessing },
  { name: "inflight-content", run: recoverInflightContent },
];

/**
 * Run every recovery step once, in order. Never throws — a step that fails
 * (most often because the schema is still migrating) is logged and skipped so
 * one bad step cannot block the rest.
 */
export function runRecovery(): void {
  for (const step of RECOVERY_STEPS) {
    log.info({ step: step.name }, "Running recovery step");
    try {
      step.run();
    } catch (err) {
      log.warn({ err, step: step.name }, "Recovery step failed");
    }
  }
}

export interface RecoveryHandle {
  stop(): void;
}

/**
 * Schedule the one-shot recovery run shortly after the monitor starts. Runs
 * once per monitor lifetime — the next reconciliation happens on the next
 * daemon (and monitor) restart. The timer is unref'd so recovery never keeps
 * the process alive; the returned handle cancels it if the monitor shuts down
 * before it fires.
 */
export function startRecovery(): RecoveryHandle {
  const timer = setTimeout(runRecovery, RECOVERY_DELAY_MS);
  timer.unref?.();
  return {
    stop() {
      clearTimeout(timer);
    },
  };
}

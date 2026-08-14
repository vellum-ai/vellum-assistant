import type { PluginActivationContext } from "./activation.js";

/** Absolute wall-clock time at which a worker wants another invocation. */
export type PluginWorkerWakeTime = Date | number;

export interface PluginWorkerResult {
  /** Date or Unix epoch milliseconds for the next host-managed invocation. */
  readonly nextWakeAt?: PluginWorkerWakeTime | null;
}

export interface PluginWorkerContext extends PluginActivationContext {
  /** Ask the host to invoke this worker again as soon as its current run ends. */
  readonly requestWake: () => void;
}

/** A bounded batch of durable work owned by one external plugin. */
export type PluginWorker = (
  context: PluginWorkerContext,
) => Promise<PluginWorkerResult | void> | PluginWorkerResult | void;

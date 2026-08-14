import { basename } from "node:path";

import type { PluginLogger } from "../hooks/types.js";
import type {
  PluginWorkerContext,
  PluginWorkerResult,
  PluginWorkerWakeTime,
} from "../plugin-api/plugin-worker.js";
import { getLogger } from "../util/logger.js";
import { APP_VERSION } from "../version.js";
import {
  type ExternalPluginWorker,
  loadExternalPluginWorkers,
} from "./external-plugin-workers.js";
import { runInPluginContext } from "./plugin-execution-context.js";
import { resolvePluginStorageDir } from "./plugin-storage.js";

const STOP_TIMEOUT_MS = 5_000;
const INITIAL_RUN_TIMEOUT_MS = 30_000;
const MIN_WAKE_DELAY_MS = 10;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const log = getLogger("plugin-worker-runner");

export interface StartPluginWorkersOptions {
  readonly importTimeoutMs?: number;
  readonly initialRunTimeoutMs?: number;
}

export interface StartPluginWorkersResult {
  readonly pluginId: string;
  readonly workerCount: number;
  readonly started: boolean;
}

export interface StopPluginWorkersOptions {
  readonly timeoutMs?: number;
}

interface WorkerRuntime {
  readonly definition: ExternalPluginWorker;
  readonly context: PluginWorkerContext;
  readonly controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  wakeRequested: boolean;
  nextWakeAt: number | null;
  stopped: boolean;
}

interface PluginWorkerActivation {
  readonly workers: WorkerRuntime[];
  state: "active" | "stopping";
}

const activations = new Map<string, PluginWorkerActivation>();

function toWakeEpoch(value: PluginWorkerWakeTime): number | null {
  const epoch = value instanceof Date ? value.getTime() : value;
  return Number.isFinite(epoch) ? epoch : null;
}

function clearWakeTimer(runtime: WorkerRuntime): void {
  if (runtime.timer !== null) {
    clearTimeout(runtime.timer);
    runtime.timer = null;
  }
  runtime.nextWakeAt = null;
}

function armWakeTimer(runtime: WorkerRuntime): void {
  if (runtime.stopped || runtime.controller.signal.aborted) {
    return;
  }
  const nextWakeAt = runtime.nextWakeAt;
  if (nextWakeAt === null) {
    return;
  }
  const remainingMs = nextWakeAt - Date.now();
  const delayMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, remainingMs));
  runtime.timer = setTimeout(() => {
    runtime.timer = null;
    if (runtime.nextWakeAt !== null && runtime.nextWakeAt > Date.now()) {
      armWakeTimer(runtime);
      return;
    }
    runtime.nextWakeAt = null;
    void invokeWorker(runtime);
  }, delayMs);
  runtime.timer.unref?.();
}

function scheduleWorker(runtime: WorkerRuntime, delayMs: number): void {
  if (runtime.stopped || runtime.controller.signal.aborted) {
    return;
  }
  clearWakeTimer(runtime);
  runtime.nextWakeAt = Date.now() + Math.max(0, delayMs);
  armWakeTimer(runtime);
}

function requestWorkerWake(runtime: WorkerRuntime): void {
  if (runtime.stopped || runtime.controller.signal.aborted) {
    return;
  }
  if (runtime.inFlight !== null) {
    runtime.wakeRequested = true;
    return;
  }
  scheduleWorker(runtime, 0);
}

function scheduleNextWake(
  runtime: WorkerRuntime,
  result: PluginWorkerResult | void,
): void {
  if (runtime.wakeRequested) {
    runtime.wakeRequested = false;
    scheduleWorker(runtime, 0);
    return;
  }
  if (result?.nextWakeAt === undefined || result.nextWakeAt === null) {
    return;
  }
  const epoch = toWakeEpoch(result.nextWakeAt);
  if (epoch === null) {
    runtime.context.logger.warn(
      { nextWakeAt: result.nextWakeAt },
      "plugin worker returned an invalid next wake time",
    );
    return;
  }
  scheduleWorker(runtime, Math.max(MIN_WAKE_DELAY_MS, epoch - Date.now()));
}

async function executeWorker(
  runtime: WorkerRuntime,
  rejectOnFailure: boolean,
): Promise<void> {
  let result: PluginWorkerResult | void = undefined;
  try {
    result = await runInPluginContext(runtime.definition.pluginId, () =>
      runtime.definition.run(runtime.context),
    );
  } catch (err) {
    if (rejectOnFailure) {
      throw err;
    }
    if (!runtime.controller.signal.aborted) {
      runtime.context.logger.error({ err }, "plugin worker failed");
    }
  }
  if (!runtime.stopped && !runtime.controller.signal.aborted) {
    scheduleNextWake(runtime, result);
  }
}

async function invokeWorker(
  runtime: WorkerRuntime,
  rejectOnFailure = false,
): Promise<void> {
  if (
    runtime.stopped ||
    runtime.controller.signal.aborted ||
    runtime.inFlight !== null
  ) {
    return;
  }
  const run = Promise.resolve().then(() =>
    executeWorker(runtime, rejectOnFailure),
  );
  runtime.inFlight = run;
  try {
    await run;
  } finally {
    if (runtime.inFlight === run) {
      runtime.inFlight = null;
    }
  }
}

function createWorkerRuntime(
  worker: ExternalPluginWorker,
  pluginStorageDir: string,
): WorkerRuntime {
  const controller = new AbortController();
  const logger = log.child({
    plugin: worker.pluginId,
    worker: worker.name,
  }) as PluginLogger;
  const runtime: WorkerRuntime = {
    definition: worker,
    context: {
      pluginId: worker.pluginId,
      pluginStorageDir,
      assistantVersion: APP_VERSION,
      signal: controller.signal,
      logger,
      requestWake: () => requestWorkerWake(runtime),
    },
    controller,
    timer: null,
    inFlight: null,
    wakeRequested: false,
    nextWakeAt: null,
    stopped: false,
  };
  return runtime;
}

/** Load and start one host-managed activation for an external plugin. */
export async function startPluginWorkers(
  pluginDir: string,
  options: StartPluginWorkersOptions = {},
): Promise<StartPluginWorkersResult> {
  const pluginId = basename(pluginDir);
  const current = activations.get(pluginId);
  if (current !== undefined) {
    if (current.state === "stopping") {
      throw new Error(`plugin ${pluginId} workers are still stopping`);
    }
    return {
      pluginId,
      workerCount: current.workers.length,
      started: false,
    };
  }

  const workers = await loadExternalPluginWorkers(
    pluginDir,
    options.importTimeoutMs,
  );
  const pluginStorageDir = resolvePluginStorageDir(pluginId, pluginDir);
  const activation: PluginWorkerActivation = {
    workers: workers.map((worker) =>
      createWorkerRuntime(worker, pluginStorageDir),
    ),
    state: "active",
  };
  activations.set(pluginId, activation);
  let initialRunTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(
        activation.workers.map((runtime) => invokeWorker(runtime, true)),
      ),
      new Promise<never>((_, reject) => {
        initialRunTimer = setTimeout(
          () =>
            reject(
              new Error(`plugin ${pluginId} initial worker run timed out`),
            ),
          options.initialRunTimeoutMs ?? INITIAL_RUN_TIMEOUT_MS,
        );
        initialRunTimer.unref?.();
      }),
    ]);
  } catch (err) {
    await stopPluginWorkers(pluginId);
    log.error({ err, plugin: pluginId }, "plugin initial worker run failed");
    throw err;
  } finally {
    if (initialRunTimer !== undefined) {
      clearTimeout(initialRunTimer);
    }
  }
  return { pluginId, workerCount: workers.length, started: true };
}

async function awaitStoppedWorkers(
  workers: readonly WorkerRuntime[],
  timeoutMs: number,
): Promise<boolean> {
  const pending = workers.flatMap((worker) =>
    worker.inFlight === null ? [] : [worker.inFlight],
  );
  if (pending.length === 0) {
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Abort and drain all workers for one plugin activation. */
export async function stopPluginWorkers(
  pluginId: string,
  options: StopPluginWorkersOptions = {},
): Promise<void> {
  const activation = activations.get(pluginId);
  if (activation === undefined) {
    return;
  }
  activation.state = "stopping";
  for (const worker of activation.workers) {
    worker.stopped = true;
    clearWakeTimer(worker);
    worker.controller.abort(new Error(`plugin ${pluginId} stopped`));
  }
  const stopped = await awaitStoppedWorkers(
    activation.workers,
    options.timeoutMs ?? STOP_TIMEOUT_MS,
  );
  if (stopped) {
    if (activations.get(pluginId) === activation) {
      activations.delete(pluginId);
    }
    return;
  }

  const pending = activation.workers.flatMap((worker) =>
    worker.inFlight === null ? [] : [worker.inFlight],
  );
  log.warn(
    { plugin: pluginId, workerCount: pending.length },
    "plugin workers did not stop before timeout",
  );
  void Promise.allSettled(pending).then(() => {
    if (activations.get(pluginId) === activation) {
      activations.delete(pluginId);
    }
  });
}

/** Abort every active external plugin worker. */
export async function stopAllPluginWorkers(
  options: StopPluginWorkersOptions = {},
): Promise<void> {
  await Promise.all(
    [...activations.keys()].map((pluginId) =>
      stopPluginWorkers(pluginId, options),
    ),
  );
}

/** Current worker count for one activation. */
export function getActivePluginWorkerCount(pluginId: string): number {
  return activations.get(pluginId)?.workers.length ?? 0;
}

/** Wait until a plugin has no active invocation. Test-only. */
export async function waitForPluginWorkersIdleForTests(
  pluginId: string,
): Promise<void> {
  for (;;) {
    const activation = activations.get(pluginId);
    if (
      activation === undefined ||
      activation.workers.every(
        (worker) => worker.inFlight === null && worker.timer === null,
      )
    ) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

/** Stop workers and clear runner state. Test-only. */
export async function resetPluginWorkerRunnerForTests(): Promise<void> {
  await stopAllPluginWorkers({ timeoutMs: 100 });
}

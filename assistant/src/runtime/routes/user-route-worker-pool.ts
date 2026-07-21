/**
 * Worker-thread pool for executing user-defined route handlers off the daemon's
 * main event loop.
 *
 * Why: user route handlers are arbitrary user/app-authored code run in-process.
 * A handler that blocks synchronously (`while(true){}`, a sync sleep, a blocking
 * `execSync`) freezes whatever event loop it runs on. Running handlers inline on
 * the daemon's loop therefore lets one route stall the entire daemon. Each
 * handler here runs on a `node:worker_threads` Worker with its own event loop,
 * so a synchronous stall pins only that worker's thread and the daemon stays
 * responsive.
 *
 * ## Replace-on-timeout, not kill-on-timeout
 *
 * On Bun (JavaScriptCore), `Worker.terminate()` is cooperative: it cannot
 * interrupt a synchronous loop, only a worker that has reached a yield point
 * (verified against Bun 1.3.x). So a worker wedged in a sync loop cannot be
 * forcibly reclaimed in-process. This pool therefore does NOT promise to kill a
 * runaway; it promises the daemon stays alive and the client gets a prompt 504:
 *
 * - On per-request timeout, the request is answered `504` immediately (the main
 *   loop is free, so the timer fires), and the worker is **poisoned**: removed
 *   from the pool and `terminate()`d best-effort (fire-and-forget — the promise
 *   may never settle for a truly infinite sync loop). A fresh worker is spawned
 *   so pool capacity is preserved. A wedged handler thus costs at most one
 *   leaked thread until the process restarts, never permanent pool degradation.
 * - The pool is bounded (`maxWorkers`) with a bounded wait queue (`maxQueue`);
 *   sustained abuse returns `503` rather than growing without limit.
 *
 * For hard, OS-enforced reclamation (kill -9) the handler must run in a
 * subprocess instead — a heavier design tracked separately.
 */

import { Worker } from "node:worker_threads";

import { getLogger } from "../../util/logger.js";
import type { UserRouteContext } from "./user-route-dispatcher.js";
import type {
  ContextCallMessage,
  SerializedRequest,
  SerializedResponse,
  WorkerOutbound,
} from "./user-route-worker-protocol.js";

const log = getLogger("user-route-worker-pool");

/** Work handed to a worker: a resolved handler file plus the serialized request. */
export interface WorkerRouteJob {
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly method: string;
  readonly request: SerializedRequest;
  /** For logging/diagnostics only (the `/x/<path>` the request targets). */
  readonly routePath: string;
}

interface InFlight {
  readonly jobId: number;
  readonly settle: (response: SerializedResponse) => void;
  readonly fail: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  /** Set once the job is resolved/failed/timed-out so late messages are ignored. */
  done: boolean;
}

interface WorkerSlot {
  readonly id: number;
  readonly worker: Worker;
  current: InFlight | null;
}

/** Raised internally when the wait queue is saturated; mapped to a 503 response. */
class QueueFullError extends Error {
  constructor() {
    super("user route worker queue is full");
    this.name = "QueueFullError";
  }
}

function jsonResponse(status: number, body: unknown): SerializedResponse {
  // `TextEncoder.encode` returns a fresh, exactly-sized Uint8Array, so its
  // backing `.buffer` is an ArrayBuffer of the right length (a valid BodyInit).
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    status,
    headers: [["content-type", "application/json"]],
    body: bytes.buffer as ArrayBuffer,
  };
}

export interface UserRouteWorkerPoolOptions {
  /** Real daemon singletons; the pool services worker context RPC against these. */
  readonly context: UserRouteContext;
  /** Max concurrent workers. Default: `min(4, availableParallelism)`. */
  readonly maxWorkers?: number;
  /** Max requests waiting for a free worker before new ones get 503. Default 100. */
  readonly maxQueue?: number;
  /** Per-request handler timeout in ms. Default 30_000. */
  readonly handlerTimeoutMs?: number;
  /** Override the worker entry module URL (tests). */
  readonly workerEntryUrl?: URL;
}

const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_QUEUE = 100;

function defaultMaxWorkers(): number {
  const cores =
    typeof navigator !== "undefined" &&
    typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(1, Math.min(4, cores));
}

export class UserRouteWorkerPool {
  private readonly context: UserRouteContext;
  private readonly maxWorkers: number;
  private readonly maxQueue: number;
  private readonly handlerTimeoutMs: number;
  private readonly workerEntryUrl: URL;

  private readonly workers = new Set<WorkerSlot>();
  private readonly idle: WorkerSlot[] = [];
  private readonly waiters: Array<(slot: WorkerSlot) => void> = [];

  private jobSeq = 0;
  private workerSeq = 0;
  private shuttingDown = false;

  constructor(options: UserRouteWorkerPoolOptions) {
    this.context = options.context;
    this.maxWorkers = options.maxWorkers ?? defaultMaxWorkers();
    this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.handlerTimeoutMs =
      options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
    this.workerEntryUrl =
      options.workerEntryUrl ??
      new URL("./user-route-worker-entry.ts", import.meta.url);
  }

  /**
   * Run one request through a worker. Always resolves to a `SerializedResponse`
   * for controlled outcomes (200 from the handler, 405, 504 timeout, 503 queue
   * full); rejects only when the handler itself threw, which the caller maps to
   * a 500.
   */
  async run(job: WorkerRouteJob): Promise<SerializedResponse> {
    let slot: WorkerSlot;
    try {
      slot = await this.acquire();
    } catch (err) {
      if (err instanceof QueueFullError) {
        log.warn(
          { routePath: job.routePath, maxQueue: this.maxQueue },
          "User route worker queue saturated — returning 503",
        );
        return jsonResponse(503, {
          error: "user routes are busy; retry shortly",
        });
      }
      throw err;
    }

    const jobId = ++this.jobSeq;
    return new Promise<SerializedResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => this.onTimeout(slot),
        this.handlerTimeoutMs,
      );
      slot.current = {
        jobId,
        settle: resolve,
        fail: reject,
        timer,
        done: false,
      };
      slot.worker.postMessage({
        type: "job",
        jobId,
        filePath: job.filePath,
        mtimeMs: job.mtimeMs,
        method: job.method,
        request: job.request,
      });
    });
  }

  /** Terminate all workers. Best-effort; wedged workers may not stop. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const all = [...this.workers];
    this.workers.clear();
    this.idle.length = 0;
    this.waiters.length = 0;
    await Promise.allSettled(all.map((slot) => slot.worker.terminate()));
  }

  // -------------------------------------------------------------------------
  // Slot lifecycle
  // -------------------------------------------------------------------------

  private acquire(): Promise<WorkerSlot> {
    return new Promise<WorkerSlot>((resolve, reject) => {
      if (this.idle.length > 0) {
        resolve(this.idle.pop()!);
        return;
      }
      if (this.workers.size < this.maxWorkers) {
        resolve(this.spawnWorker());
        return;
      }
      if (this.waiters.length >= this.maxQueue) {
        reject(new QueueFullError());
        return;
      }
      this.waiters.push(resolve);
    });
  }

  /** Hand a free slot back and wake the next waiter, or park it as idle. */
  private release(slot: WorkerSlot): void {
    slot.current = null;
    if (!this.workers.has(slot)) {
      // Poisoned/exited while its job was resolving — drop it.
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(slot);
      return;
    }
    this.idle.push(slot);
  }

  private spawnWorker(): WorkerSlot {
    const worker = new Worker(this.workerEntryUrl);
    const slot: WorkerSlot = { id: ++this.workerSeq, worker, current: null };
    this.workers.add(slot);

    worker.on("message", (message: WorkerOutbound) =>
      this.onWorkerMessage(slot, message),
    );
    worker.on("error", (err: Error) => {
      log.error({ workerId: slot.id, err }, "User route worker errored");
      this.failCurrent(slot, err);
      this.removeWorker(slot);
    });
    worker.on("exit", (code: number) => {
      if (slot.current && !slot.current.done) {
        this.failCurrent(slot, new Error(`worker exited (code ${code})`));
      }
      this.removeWorker(slot);
    });

    return slot;
  }

  private onWorkerMessage(slot: WorkerSlot, message: WorkerOutbound): void {
    switch (message.type) {
      case "ctx-call":
        void this.serviceContextCall(slot, message);
        return;
      case "result": {
        const inFlight = slot.current;
        if (!inFlight || inFlight.done || inFlight.jobId !== message.jobId) {
          return;
        }
        inFlight.done = true;
        clearTimeout(inFlight.timer);
        inFlight.settle(message.response);
        this.release(slot);
        return;
      }
      case "error": {
        const inFlight = slot.current;
        if (!inFlight || inFlight.done || inFlight.jobId !== message.jobId) {
          return;
        }
        inFlight.done = true;
        clearTimeout(inFlight.timer);
        inFlight.fail(new Error(message.error.message));
        this.release(slot);
        return;
      }
    }
  }

  /** Service a handler's `context` method call against the real daemon singletons. */
  private async serviceContextCall(
    slot: WorkerSlot,
    message: ContextCallMessage,
  ): Promise<void> {
    let reply: {
      ok: boolean;
      value?: unknown;
      error?: { message: string; code?: string };
    };
    try {
      let value: unknown;
      if (message.method === "publish") {
        // Handlers don't consume publish's return value; send nothing back to
        // avoid cloning a non-serializable result across the boundary.
        await this.context.assistantEventHub.publish(
          message.args[0] as Parameters<
            UserRouteContext["assistantEventHub"]["publish"]
          >[0],
        );
        value = undefined;
      } else {
        value = await this.context.conversations.postMessage(
          message.args[0] as string,
          message.args[1] as string,
        );
      }
      reply = { ok: true, value };
    } catch (err) {
      reply = {
        ok: false,
        error: {
          message: err instanceof Error ? err.message : String(err),
          code: (err as { code?: string })?.code,
        },
      };
    }

    try {
      slot.worker.postMessage({
        type: "ctx-result",
        callId: message.callId,
        ...reply,
      });
    } catch {
      // Worker was terminated between the call and the reply — nothing to do.
    }
  }

  private onTimeout(slot: WorkerSlot): void {
    const inFlight = slot.current;
    if (!inFlight || inFlight.done) {
      return;
    }
    inFlight.done = true;
    log.error(
      { workerId: slot.id, timeoutMs: this.handlerTimeoutMs },
      "User route handler timed out — poisoning worker",
    );
    inFlight.settle(
      jsonResponse(504, {
        error: `route handler timed out after ${this.handlerTimeoutMs}ms`,
      }),
    );
    // Never reuse a worker that may be wedged in a synchronous loop.
    this.poison(slot);
  }

  /** Remove a worker and, best-effort, terminate it; keep capacity for waiters. */
  private poison(slot: WorkerSlot): void {
    if (this.removeWorker(slot)) {
      // Fire-and-forget: terminate() may never settle on a sync-wedged worker.
      void slot.worker.terminate().catch(() => {});
    }
  }

  private failCurrent(slot: WorkerSlot, err: Error): void {
    const inFlight = slot.current;
    if (!inFlight || inFlight.done) {
      return;
    }
    inFlight.done = true;
    clearTimeout(inFlight.timer);
    inFlight.fail(err);
  }

  /** Drop a worker from the pool and re-spawn to serve any waiter. Returns whether it was present. */
  private removeWorker(slot: WorkerSlot): boolean {
    const present = this.workers.delete(slot);
    const idx = this.idle.indexOf(slot);
    if (idx >= 0) {
      this.idle.splice(idx, 1);
    }
    if (present && !this.shuttingDown) {
      this.dispatchWaiters();
    }
    return present;
  }

  /** Satisfy waiters up to capacity by reusing idle slots or spawning new ones. */
  private dispatchWaiters(): void {
    while (
      this.waiters.length > 0 &&
      (this.idle.length > 0 || this.workers.size < this.maxWorkers)
    ) {
      const waiter = this.waiters.shift()!;
      const slot = this.idle.pop() ?? this.spawnWorker();
      waiter(slot);
    }
  }
}

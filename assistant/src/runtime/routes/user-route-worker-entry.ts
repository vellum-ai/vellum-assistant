/**
 * Worker-thread entry point for user-defined route handlers.
 *
 * Runs on a `node:worker_threads` Worker owned by {@link UserRouteWorkerPool}.
 * One job at a time: it imports the resolved handler module in the worker's own
 * isolate, runs the method handler against a reconstructed `Request`, and posts
 * the marshaled `Response` back to the pool. Because this runs off the daemon's
 * main event loop, a handler that blocks synchronously (a busy loop, a sync
 * sleep) pins only this worker's thread — the daemon stays responsive.
 *
 * Deliberately dependency-light: the only imports are `node:worker_threads` and
 * the type-only wire protocol. Nothing from the daemon's `src/` graph loads
 * here, so each worker isolate stays small and can't accidentally touch daemon
 * singletons — the handler `context` reaches them only via RPC back to the pool.
 *
 * NOTE (Bun/JavaScriptCore): `Worker.terminate()` cannot interrupt a
 * synchronous loop — it only takes effect at a yield point. The pool relies on
 * this file keeping the handler on the worker's own thread; forcible
 * reclamation of a wedged handler is not possible in-process (see the pool's
 * replace-on-timeout strategy).
 */

import { parentPort } from "node:worker_threads";

import type {
  ContextCallMethod,
  JobMessage,
  SerializedRequest,
  SerializedResponse,
  WorkerInbound,
} from "./user-route-worker-protocol.js";

if (!parentPort) {
  throw new Error("user-route-worker-entry must run as a worker thread");
}
const port = parentPort;

/** HTTP methods a handler module may export (mirrors the dispatcher's list). */
const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

// ---------------------------------------------------------------------------
// Context RPC — handler → pool
// ---------------------------------------------------------------------------

let ctxCallSeq = 0;
const pendingCtxCalls = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (err: Error) => void }
>();

/**
 * Invoke a `context` method on the main thread and await its result. The
 * handler's own await keeps the worker's event loop free to receive the reply,
 * so RPC works for any handler that isn't itself blocking synchronously.
 */
function callContext(
  method: ContextCallMethod,
  args: unknown[],
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const callId = ++ctxCallSeq;
    pendingCtxCalls.set(callId, { resolve, reject });
    port.postMessage({ type: "ctx-call", callId, method, args });
  });
}

/**
 * The handler-facing `context`. Mirrors `UserRouteContext` but every method is
 * an RPC stub — the real event hub and conversation store live on the main
 * thread. Frozen so a handler can't reassign the surface (matches the in-thread
 * dispatcher's frozen context).
 */
function buildContext(): unknown {
  return Object.freeze({
    assistantEventHub: Object.freeze({
      publish: (event: unknown, options?: unknown) =>
        callContext("publish", [event, options]),
    }),
    conversations: Object.freeze({
      postMessage: (conversationId: unknown, text: unknown) =>
        callContext("postMessage", [conversationId, text]),
    }),
  });
}

// ---------------------------------------------------------------------------
// Request / response marshaling
// ---------------------------------------------------------------------------

function reconstructRequest(serialized: SerializedRequest): Request {
  const headers = new Headers();
  for (const [name, value] of serialized.headers) {
    headers.append(name, value);
  }
  const init: RequestInit = { method: serialized.method, headers };
  // GET/HEAD may not carry a body; other methods pass the raw bytes through.
  if (
    serialized.body &&
    serialized.method !== "GET" &&
    serialized.method !== "HEAD"
  ) {
    init.body = serialized.body;
  }
  return new Request(serialized.url, init);
}

async function marshalResponse(
  response: Response,
): Promise<SerializedResponse> {
  const buffer = await response.arrayBuffer();
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => {
    headers.push([name, value]);
  });
  return {
    status: response.status,
    headers,
    body: buffer.byteLength > 0 ? buffer : null,
  };
}

// ---------------------------------------------------------------------------
// Job execution
// ---------------------------------------------------------------------------

async function runJob(job: JobMessage): Promise<void> {
  // Cache-bust per mtime so an edited handler is re-imported (each worker keeps
  // its own module cache, so this must live here, not on the main thread).
  const mod = (await import(`${job.filePath}?t=${job.mtimeMs}`)) as Record<
    string,
    unknown
  >;

  const handler = mod[job.method];
  if (typeof handler !== "function") {
    const allowed = HTTP_METHODS.filter((m) => typeof mod[m] === "function");
    port.postMessage({
      type: "result",
      jobId: job.jobId,
      response: {
        status: 405,
        headers: allowed.length ? [["allow", allowed.join(", ")]] : [],
        body: null,
      },
    });
    return;
  }

  const request = reconstructRequest(job.request);
  const result = (await (handler as (req: Request, ctx: unknown) => unknown)(
    request,
    buildContext(),
  )) as Response;

  const response = await marshalResponse(result);
  port.postMessage({ type: "result", jobId: job.jobId, response });
}

port.on("message", (message: WorkerInbound) => {
  if (message.type === "job") {
    runJob(message).catch((err: unknown) => {
      port.postMessage({
        type: "error",
        jobId: message.jobId,
        error: {
          message: err instanceof Error ? err.message : String(err),
        },
      });
    });
    return;
  }

  if (message.type === "ctx-result") {
    const pending = pendingCtxCalls.get(message.callId);
    if (!pending) {
      return;
    }
    pendingCtxCalls.delete(message.callId);
    if (message.ok) {
      pending.resolve(message.value);
    } else {
      // Rebuild the error so handler catch blocks can read `.code`
      // (e.g. RouteMessageError's "not_found" | "rate_limited" | "invalid").
      const err = new Error(message.error?.message ?? "context call failed");
      if (message.error?.code) {
        (err as Error & { code?: string }).code = message.error.code;
      }
      pending.reject(err);
    }
  }
});

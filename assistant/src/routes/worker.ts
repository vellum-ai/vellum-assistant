/**
 * Route host subprocess entry point.
 *
 * A dedicated OS process that runs user-defined `/x/*` route handlers off the
 * daemon, receiving invocations from the daemon over a Unix domain socket at
 * `$VELLUM_WORKSPACE_DIR/procs/routes/routes.sock`. Because it's a separate
 * process, a handler that blocks synchronously pins only this process (the
 * daemon stays responsive), and a wedged handler can be reclaimed with a hard
 * `kill` — the guarantee a worker thread could not give on Bun.
 *
 * Lifecycle mirrors the resource-monitor worker (`monitoring/worker.ts`): bind
 * the socket, then write the PID file as the readiness signal, arm the
 * PID-file guard so a superseded instance self-exits, and clean up on exit.
 *
 * Plugin handlers run inside a host-derived route context. Its bounded host
 * facade uses the closed local broker for approved main-process operations.
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";

import type { IpcEnvelope } from "@vellumai/ipc-server-utils";
import { IpcFrameReader, writeMessage } from "@vellumai/ipc-server-utils";

import {
  markCurrentProcessAsPluginRouteHost,
  type PluginRouteContext,
  runInPluginRouteContext,
} from "../plugin-api/route-context.js";
import { runInPluginContext } from "../plugins/plugin-execution-context.js";
import { disableStreamSeqStamping } from "../runtime/assistant-stream-state.js";
import { importRouteModule } from "../runtime/routes/user-route-import.js";
import { getLogger } from "../util/logger.js";
import {
  ensureProcDir,
  getProcPidPath,
  getProcSocketPath,
} from "../util/platform.js";
import {
  cleanupWorkerPidFile,
  startWorkerPidFileGuard,
} from "../util/worker-process.js";
import {
  type RouteHostBrokerRequest,
  type RouteHostBrokerResult,
  runWithRouteHostBroker,
} from "./route-host-broker.js";
import {
  ROUTE_BROKER_METHOD,
  ROUTE_CANCEL_METHOD,
  ROUTE_HOST_PROC_NAME,
  ROUTE_INVOKE_METHOD,
  type RouteCancelParams,
  type RouteInvokeParams,
} from "./route-host-protocol.js";

const log = getLogger("route-host");

const activeAbortControllers = new Map<string, AbortController>();

interface PendingBrokerCall {
  resolve: (result: RouteHostBrokerResult) => void;
  reject: (error: Error) => void;
}

const pendingBrokerCalls = new Map<string, PendingBrokerCall>();
let brokerCallSeq = 0;

const socketPath = getProcSocketPath(ROUTE_HOST_PROC_NAME);
const pidPath = getProcPidPath(ROUTE_HOST_PROC_NAME);

// ---------------------------------------------------------------------------
// Invocation handling
// ---------------------------------------------------------------------------

/** Normalize framing's `Uint8Array` body into a `BodyInit`-safe `ArrayBuffer`. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

function reconstructRequest(
  params: RouteInvokeParams,
  body: Uint8Array | undefined,
  signal: AbortSignal,
): Request {
  const headers = new Headers();
  for (const [name, value] of params.headers) {
    headers.append(name, value);
  }
  const init: RequestInit = { method: params.method, headers, signal };
  if (body && params.method !== "GET" && params.method !== "HEAD") {
    init.body = toArrayBuffer(body);
  }
  return new Request(params.url, init);
}

/** Send the handler's response back over the socket (body as a binary frame). */
function replyResult(
  socket: Socket,
  id: string,
  status: number,
  headers: [string, string][],
  body: Uint8Array | null,
): void {
  const envelope: IpcEnvelope = { id, result: { status, headers } };
  if (body && body.byteLength > 0) {
    envelope.headers = { "content-length": String(body.byteLength) };
    writeMessage(socket, envelope, body);
  } else {
    writeMessage(socket, envelope);
  }
}

function replyError(socket: Socket, id: string, message: string): void {
  writeMessage(socket, { id, error: message });
}

const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

async function handleInvoke(
  socket: Socket,
  id: string,
  params: RouteInvokeParams,
  body: Uint8Array | undefined,
): Promise<void> {
  const abortController = new AbortController();
  activeAbortControllers.set(id, abortController);
  try {
    const mod = await importRouteModule(params.filePath);

    const handler = mod[params.method];
    if (typeof handler !== "function") {
      const allowed = HTTP_METHODS.filter((m) => typeof mod[m] === "function");
      replyResult(
        socket,
        id,
        405,
        allowed.length ? [["allow", allowed.join(", ")]] : [],
        null,
      );
      return;
    }

    const request = reconstructRequest(params, body, abortController.signal);
    const serializedContext = params.pluginContext;
    const brokerTransport = serializedContext
      ? createBrokerTransport(socket, id)
      : undefined;
    const pluginContext: PluginRouteContext | undefined =
      serializedContext && brokerTransport
        ? {
            pluginId: serializedContext.pluginId,
            actor: serializedContext.actor,
            requestId: serializedContext.requestId,
            signal: abortController.signal,
            verifiedPeer: serializedContext.verifiedPeer,
            host: {
              async getPluginStorageDir(): Promise<string> {
                const result = await brokerTransport({
                  operation: "plugin.storage-dir",
                });
                return result.pluginStorageDir;
              },
            },
          }
        : undefined;
    const invoke = () => (handler as (req: Request) => unknown)(request);
    const response = (await (pluginContext && brokerTransport
      ? runWithRouteHostBroker(brokerTransport, () =>
          runInPluginContext(pluginContext.pluginId, () =>
            runInPluginRouteContext(pluginContext, invoke),
          ),
        )
      : invoke())) as Response;

    const buffer = new Uint8Array(await response.arrayBuffer());
    const headers: [string, string][] = [];
    response.headers.forEach((value, name) => {
      headers.push([name, value]);
    });
    replyResult(
      socket,
      id,
      response.status,
      headers,
      buffer.byteLength > 0 ? buffer : null,
    );
  } finally {
    activeAbortControllers.delete(id);
  }
}

function createBrokerTransport(
  socket: Socket,
  invokeId: string,
): (request: RouteHostBrokerRequest) => Promise<RouteHostBrokerResult> {
  return (request) => {
    const id = `broker:${process.pid}:${++brokerCallSeq}`;
    return new Promise<RouteHostBrokerResult>((resolve, reject) => {
      pendingBrokerCalls.set(id, { resolve, reject });
      writeMessage(socket, {
        id,
        method: ROUTE_BROKER_METHOD,
        params: { invokeId, request } as unknown as Record<string, unknown>,
      });
    });
  };
}

function onConnection(socket: Socket): void {
  const reader = new IpcFrameReader(
    (envelope, binary) => {
      if (envelope.id && pendingBrokerCalls.has(envelope.id)) {
        const pending = pendingBrokerCalls.get(envelope.id)!;
        pendingBrokerCalls.delete(envelope.id);
        if (envelope.error != null) {
          pending.reject(new Error(envelope.error));
        } else {
          pending.resolve(envelope.result as RouteHostBrokerResult);
        }
        return;
      }
      if (envelope.method === ROUTE_CANCEL_METHOD) {
        const params = envelope.params as unknown as RouteCancelParams;
        const controller = activeAbortControllers.get(params.requestId);
        if (controller) {
          controller.abort(
            new DOMException("Route request aborted", "AbortError"),
          );
        }
        return;
      }
      if (envelope.method !== ROUTE_INVOKE_METHOD || !envelope.id) {
        return;
      }
      const id = envelope.id;
      const params = envelope.params as unknown as RouteInvokeParams;
      handleInvoke(socket, id, params, binary).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, id }, "Route handler invocation failed");
        replyError(socket, id, message);
      });
    },
    (err) => log.warn({ err }, "Route host framing error"),
  );

  socket.on("data", (chunk: Buffer) => reader.push(chunk));
  socket.on("close", () => {
    for (const [, pending] of pendingBrokerCalls) {
      pending.reject(new Error("route host broker connection closed"));
    }
    pendingBrokerCalls.clear();
  });
  socket.on("error", (err) => log.warn({ err }, "Route host socket error"));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let activeServer: Server | undefined;
let disposePidGuard: (() => void) | undefined;
let shuttingDown = false;

function shutdown(reason: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log.info({ reason }, "Route host shutting down");
  disposePidGuard?.();
  activeServer?.close();
  cleanupWorkerPidFile(pidPath);
  process.exit(0);
}

function start(): void {
  markCurrentProcessAsPluginRouteHost();

  // Only the daemon stamps SSE seqs and writes the shared reservation file; a
  // worker that stamped would issue overlapping seqs and race the daemon.
  disableStreamSeqStamping();

  ensureProcDir(ROUTE_HOST_PROC_NAME);

  // Clear a stale socket from a crashed predecessor (double-spawn is already
  // prevented by the PID-file check in spawnWorkerProcess).
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // best-effort — bind will surface a real conflict
    }
  }

  const server = createServer();
  activeServer = server;
  server.on("error", (err) => {
    log.error({ err }, "Route host server error — exiting");
    process.exit(1);
  });

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  server.listen(socketPath, () => {
    // Publish the PID (readiness signal), then arm the identity guard BEFORE we
    // begin serving. The guard's on-arm check runs synchronously, so a worker
    // superseded during startup begins shutting down here instead of serving.
    writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
    disposePidGuard = startWorkerPidFileGuard(pidPath, {
      onEvicted: (reason) => shutdown(`pid-file evicted: ${reason}`),
    });
    if (shuttingDown) {
      return;
    }
    // Work-start: begin accepting route invocations only once the guard is armed.
    server.on("connection", onConnection);
    log.info({ socketPath, pid: process.pid }, "Route host ready");
  });
}

start();

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
 * Handlers run with **no injected context**. Reaching daemon state (publishing
 * events, running conversation turns) is deferred to the plugin-api once it is
 * safe out-of-process; today the host serves pure request→response handlers
 * (CRUD, file persistence, external API proxying).
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";

import type { IpcEnvelope } from "../ipc/ipc-framing.js";
import { IpcFrameReader, writeMessage } from "../ipc/ipc-framing.js";
import { getLogger } from "../util/logger.js";
import {
  cleanupWorkerPidFile,
  startWorkerPidFileGuard,
} from "../util/worker-process.js";
import {
  ensureProcDir,
  getProcPidPath,
  getProcSocketPath,
} from "./proc-paths.js";
import {
  ROUTE_HOST_PROC_NAME,
  ROUTE_INVOKE_METHOD,
  type RouteInvokeParams,
} from "./route-host-protocol.js";

const log = getLogger("route-host");

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
): Request {
  const headers = new Headers();
  for (const [name, value] of params.headers) {
    headers.append(name, value);
  }
  const init: RequestInit = { method: params.method, headers };
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
  // Each worker has its own module cache; cache-bust per mtime so an edited
  // handler is re-imported.
  const mod = (await import(
    `${params.filePath}?t=${params.mtimeMs}`
  )) as Record<string, unknown>;

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

  const request = reconstructRequest(params, body);
  const response = (await (handler as (req: Request) => unknown)(
    request,
  )) as Response;

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
}

function onConnection(socket: Socket): void {
  const reader = new IpcFrameReader(
    (envelope, binary) => {
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
  socket.on("error", (err) => log.warn({ err }, "Route host socket error"));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let server: Server | undefined;
let disposePidGuard: (() => void) | undefined;

function shutdown(reason: string): void {
  log.info({ reason }, "Route host shutting down");
  disposePidGuard?.();
  server?.close();
  cleanupWorkerPidFile(pidPath);
  process.exit(0);
}

function start(): void {
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

  server = createServer(onConnection);
  server.on("error", (err) => {
    log.error({ err }, "Route host server error — exiting");
    process.exit(1);
  });

  server.listen(socketPath, () => {
    // Readiness signal: the socket is accepting connections, so the daemon can
    // connect the moment it sees the PID file.
    writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
    disposePidGuard = startWorkerPidFileGuard(pidPath, {
      onEvicted: (reason) => shutdown(`pid-file evicted: ${reason}`),
    });
    log.info({ socketPath, pid: process.pid }, "Route host ready");
  });

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start();

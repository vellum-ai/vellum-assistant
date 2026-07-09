/**
 * Assistant IPC server — exposes daemon capabilities to CLI commands and external
 * processes over a Unix domain socket.
 *
 * This is the preferred method of inter-process communication between the
 * CLI and the daemon. File-based signals and the HTTP port are deprecated
 * in favor of this IPC socket.
 *
 * Protocol: length-prefixed binary frames over a Unix domain socket.
 * Each frame: [4-byte big-endian length][payload bytes]
 *
 * Messages use a JSON envelope:
 * - Request:  { id, method, params?, headers? }
 * - Response: { id, result?, error?, headers? }
 *
 * When a message's headers map contains "content-length", a binary data
 * frame immediately follows the JSON frame.
 *
 * Chunked streaming: when the response headers contain
 * "transfer-encoding: chunked", multiple binary data frames follow the
 * JSON envelope. A zero-length frame terminates the stream.
 *
 * Legacy newline-delimited JSON is auto-detected and supported for
 * backward compatibility with older CLI clients.
 *
 * The preferred socket path is `{workspaceDir}/assistant.sock`. On
 * platforms with strict AF_UNIX path limits (notably macOS), the server falls
 * back to a shorter deterministic path so CLI commands can still connect.
 */

import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";

import { ensureSocketDir, SocketWatchdog } from "@vellumai/ipc-server-utils";

import {
  getDbMigrationReadiness,
  isDbMigrationGateBypassed,
} from "../daemon/daemon-readiness.js";
import type { PrincipalType } from "../runtime/auth/types.js";
import { findLocalGuardianPrincipalIdFromStore } from "../runtime/local-actor-identity.js";
import { RouteError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/index.js";
import type {
  RouteDefinition,
  RouteHandlerArgs,
} from "../runtime/routes/types.js";
import { RouteResponse } from "../runtime/routes/types.js";
import { getLogger } from "../util/logger.js";
import {
  type IpcEnvelope,
  IpcFrameReader,
  writeLegacyMessage,
  writeMessage,
  writeStreamChunk,
  writeStreamEnd,
} from "./ipc-framing.js";
import { CONTACTS_INFO_IPC_METHODS } from "./routes/contacts-info-ipc-routes.js";
import { CONTACTS_MIRROR_IPC_METHODS } from "./routes/contacts-mirror-ipc-routes.js";
import { type DbProxyParams, handleDbProxy } from "./routes/db-proxy.js";
import { GUARDIAN_LABEL_IPC_METHODS } from "./routes/guardian-label-ipc-routes.js";
import { INVITE_IPC_METHODS } from "./routes/invite-ipc-routes.js";
import { routeDefinitionsToIpcMethods } from "./routes/route-adapter.js";
import { ensureSocketPathFree } from "./socket-cleanup.js";
import { resolveIpcSocketPath } from "./socket-path.js";

const log = getLogger("assistant-ipc-server");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IpcRequest = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
};

export type IpcResponse = {
  id: string;
  result?: unknown;
  error?: string;
  /** HTTP status code — present for all responses, not just errors. */
  statusCode?: number;
  /** Machine-readable error code (e.g. "NOT_FOUND") for RouteError instances. */
  errorCode?: string;
  /**
   * Structured error payload mirroring `RouteError.details` — present only
   * when the originating `RouteError` carries a `details` field (e.g.
   * `version_incompatible` migration imports). Mirrors the HTTP adapter's
   * `error.details` envelope so IPC clients can recover the same
   * machine-readable context as HTTP clients.
   */
  errorDetails?: unknown;
  headers?: Record<string, string>;
};

/**
 * Wrapper returned by route handlers that produce a streaming response.
 * The IPC server detects this and pipes the ReadableStream as chunked
 * binary frames instead of serializing to JSON.
 */
export interface IpcStreamingResponse {
  stream: ReadableStream<Uint8Array>;
  headers: Record<string, string>;
}

/**
 * Wrapper returned by route handlers that produce a single binary response.
 * Sent as a JSON envelope with content-length followed by one binary frame.
 */
export interface IpcBinaryResponse {
  binary: Uint8Array;
  headers: Record<string, string>;
}

function isIpcStreamingResponse(value: unknown): value is IpcStreamingResponse {
  return (
    value != null &&
    typeof value === "object" &&
    "stream" in value &&
    (value as IpcStreamingResponse).stream instanceof ReadableStream &&
    "headers" in value &&
    typeof (value as IpcStreamingResponse).headers === "object"
  );
}

function isIpcBinaryResponse(value: unknown): value is IpcBinaryResponse {
  return (
    value != null &&
    typeof value === "object" &&
    "binary" in value &&
    (value as IpcBinaryResponse).binary instanceof Uint8Array &&
    "headers" in value &&
    typeof (value as IpcBinaryResponse).headers === "object"
  );
}

/**
 * A handler result whose body is raw bytes or a stream rather than a JSON
 * value — `RouteResponse` (e.g. `workspace/file/content` returns a
 * `Bun.file`), or a bare `Uint8Array` / `ReadableStream` / `Blob`.
 *
 * These cannot be carried as a JSON `result` field, so over the IPC
 * transport they are reported as a structured error rather than silently
 * JSON-serialized into garbage. Distinct from the `IpcBinaryResponse` /
 * `IpcStreamingResponse` wrappers, which are explicit binary envelopes the
 * framing protocol does transmit.
 */
function isNonJsonIpcResult(value: unknown): boolean {
  return (
    value instanceof RouteResponse ||
    value instanceof Uint8Array ||
    value instanceof ReadableStream ||
    value instanceof Blob
  );
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/** Optional configuration for {@link AssistantIpcServer}. */
export interface AssistantIpcServerOptions {
  /**
   * How often the socket-file watchdog stats the listening socket path.
   * Set to `0` to disable. Defaults to {@link SocketWatchdog}'s 5000ms.
   */
  watchdogIntervalMs?: number;
}

export class AssistantIpcServer {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private methods = new Map<string, RouteDefinition["handler"]>();
  private socketPath: string;
  private watchdog: SocketWatchdog;
  /**
   * Servers whose listener path has been replaced by a re-bind. Kept around
   * so already-connected sockets continue to work; closed gracefully once
   * their accept loops drain.
   */
  private legacyServers = new Set<Server>();
  private abortControllers = new Map<string, AbortController>();

  constructor(options?: AssistantIpcServerOptions) {
    const resolution = resolveIpcSocketPath("assistant");
    this.socketPath = resolution.path;
    log.info(
      { source: resolution.source, path: resolution.path },
      "Assistant IPC socket path resolved",
    );
    for (const route of routeDefinitionsToIpcMethods(ROUTES)) {
      this.methods.set(route.operationId, route.handler);
    }

    // Gateway→assistant DB proxy — one-time gateway data migrations only,
    // never runtime features (see ipc/routes/db-proxy.ts; allowlist-guarded).
    // This is the ONLY route defined directly here; all other routes go in
    // ROUTES.
    this.methods.set("db_proxy", (params) =>
      handleDbProxy(params as unknown as DbProxyParams),
    );

    // IPC-only invite methods (see ipc/routes/invite-ipc-routes.ts). The
    // gateway calls these back over IPC to mirror redeemed-invite contact
    // info locally. No HTTP surface; never in ROUTES.
    for (const [operationId, handler] of Object.entries(INVITE_IPC_METHODS)) {
      this.methods.set(operationId, handler);
    }

    // IPC-only contact INFO-READ methods (see ipc/routes/contacts-info-ipc-routes.ts).
    // The gateway calls these to read assistant-owned info fields + channel
    // identity, replacing raw db_proxy SELECTs. No HTTP surface; never in ROUTES.
    for (const [operationId, handler] of Object.entries(
      CONTACTS_INFO_IPC_METHODS,
    )) {
      this.methods.set(operationId, handler);
    }

    // IPC-only contact identity-mirror methods (see
    // ipc/routes/contacts-mirror-ipc-routes.ts). The gateway calls these back
    // over IPC to mirror single-row contact/channel identity locally after a
    // gateway-owned ACL write. No HTTP surface; never in ROUTES.
    for (const [operationId, handler] of Object.entries(
      CONTACTS_MIRROR_IPC_METHODS,
    )) {
      this.methods.set(operationId, handler);
    }

    // IPC-only guardian-label method (see ipc/routes/guardian-label-ipc-routes.ts).
    // The gateway calls this to resolve the guardian's display label (persona
    // preferred name) for its native contact reads. No HTTP surface; never in
    // ROUTES.
    for (const [operationId, handler] of Object.entries(
      GUARDIAN_LABEL_IPC_METHODS,
    )) {
      this.methods.set(operationId, handler);
    }

    this.methods.set("$cancel", (params) => {
      const targetId = (params as { targetId?: string }).targetId;
      if (targetId) {
        this.abortControllers.get(targetId)?.abort();
      }
      return null;
    });

    this.watchdog = new SocketWatchdog({
      socketPath: this.socketPath,
      intervalMs: options?.watchdogIntervalMs,
      getServer: () => this.server,
      createServer: () => this.createListeningServer(),
      onRebind: (newServer, oldServer) => {
        this.server = newServer;
        this.legacyServers.add(oldServer);
        oldServer.close(() => {
          this.legacyServers.delete(oldServer);
        });
      },
      log,
    });
  }

  /** Start listening on the Unix domain socket. */
  async start(): Promise<void> {
    // Ensure the parent directory exists before listening.
    ensureSocketDir(this.socketPath);

    // Probe before unlink so a second daemon can't silently orphan an active
    // listener (Unix lets you unlink a still-bound socket file). See
    // `ensureSocketPathFree` for the behavior matrix.
    await ensureSocketPathFree(this.socketPath);

    this.server = this.createListeningServer();
    this.server.listen(this.socketPath, () => {
      log.info({ path: this.socketPath }, "Assistant IPC server listening");
    });

    this.watchdog.start();
  }

  /** Stop the server and disconnect all clients. */
  stop(): void {
    this.watchdog.stop();

    for (const ctrl of this.abortControllers.values()) {
      ctrl.abort();
    }
    this.abortControllers.clear();

    for (const client of this.clients) {
      if (!client.destroyed) {
        client.destroy();
      }
    }
    this.clients.clear();

    for (const legacy of this.legacyServers) {
      legacy.close();
    }
    this.legacyServers.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Ignore
      }
    }
  }

  /** Get the socket path (for diagnostics). */
  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * Re-bind the listening socket if its path entry is missing on disk.
   *
   * Public for tests so the watchdog can be exercised deterministically
   * without waiting for the interval. Returns `true` when a re-bind was
   * performed, `false` otherwise.
   */
  async rebindIfMissing(): Promise<boolean> {
    return this.watchdog.rebindIfMissing();
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private createListeningServer(): Server {
    const server = createServer((socket) => {
      this.clients.add(socket);
      log.debug("IPC client connected");

      const reader = new IpcFrameReader(
        (envelope, binary) =>
          this.handleEnvelope(socket, reader, envelope, binary),
        (err) => log.warn({ err }, "IPC frame read error"),
      );

      socket.on("data", (chunk) => {
        reader.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      socket.on("close", () => {
        this.clients.delete(socket);
        log.debug("IPC client disconnected");
      });

      socket.on("error", (err) => {
        log.warn({ err }, "IPC client socket error");
        this.clients.delete(socket);
      });
    });

    server.on("error", (err) => {
      log.error({ err }, "Assistant IPC server error");
    });

    return server;
  }

  private handleEnvelope(
    socket: Socket,
    reader: IpcFrameReader,
    envelope: IpcEnvelope,
    binary: Uint8Array | undefined,
  ): void {
    const req = envelope as IpcRequest;

    if (!req.id || !req.method) {
      const id = typeof req.id === "string" ? req.id : "unknown";
      this.sendResponse(socket, reader, {
        id,
        error: "Missing 'id' or 'method' field",
      });
      return;
    }

    const handler = this.methods.get(req.method);
    if (!handler) {
      this.sendResponse(socket, reader, {
        id: req.id,
        error: `Unknown method: ${req.method}`,
      });
      return;
    }

    // Gate ORM-touching methods on DB migration readiness. Migrations run
    // asynchronously during startup, so the IPC server can be answering before
    // the schema exists; dispatching a handler that calls getDb()/getSqlite()
    // would hit a "no such table" error.
    const migrationGate = this.dbMigrationGateResponse(req.method, req.id);
    if (migrationGate) {
      this.sendResponse(socket, reader, migrationGate);
      return;
    }

    void binary;

    // Skip AbortController for the $cancel meta-method itself
    const needsAbortTracking = req.method !== "$cancel";
    let abortController: AbortController | undefined;
    if (needsAbortTracking) {
      abortController = new AbortController();
      this.abortControllers.set(req.id, abortController);
    }

    try {
      const handlerArgs = {
        ...injectLocalActorHeader(req.params),
        ...(abortController && { abortSignal: abortController.signal }),
      };
      const result = handler(handlerArgs);

      if (result instanceof Promise) {
        result
          .then((value) => {
            // For streaming responses, keep the AbortController alive until the
            // stream ends — sendStreamingResponse deletes it on completion/error.
            if (!isIpcStreamingResponse(value)) {
              this.abortControllers.delete(req.id);
            }
            this.sendResult(socket, reader, req.id, value);
          })
          .catch((err) => {
            this.abortControllers.delete(req.id);
            log.warn({ err, method: req.method }, "IPC handler error");
            this.sendResponse(
              socket,
              reader,
              this.buildErrorResponse(req.id, err),
            );
          });
      } else {
        if (!isIpcStreamingResponse(result)) {
          this.abortControllers.delete(req.id);
        }
        this.sendResult(socket, reader, req.id, result);
      }
    } catch (err) {
      this.abortControllers.delete(req.id);
      log.warn({ err, method: req.method }, "IPC handler error");
      this.sendResponse(socket, reader, this.buildErrorResponse(req.id, err));
    }
  }

  /**
   * Returns a retryable 503 error envelope when an ORM-touching IPC method is
   * called while DB migrations are not ready, or `null` when the call may
   * proceed. Exempt methods (health/healthz/ps/$cancel) always return `null` so
   * the gateway can poll `health` to observe when migrations finish (see
   * gateway/src/post-assistant-ready.ts), and the migration-repair surface
   * (rollback/import — see daemon-readiness.ts) is additionally allowed in the
   * terminal failed state so recovery is possible. Carrying `statusCode` maps
   * this to an `IpcHandlerError` (not an `IpcTransportError`) on the gateway
   * client, so the warm-pool claim path waits and retries instead of failing
   * hard.
   */
  private dbMigrationGateResponse(
    method: string,
    id: string,
  ): IpcResponse | null {
    // `$cancel` only aborts an in-flight request and never reads the DB.
    if (method === "$cancel" || isDbMigrationGateBypassed(method)) return null;
    const readiness = getDbMigrationReadiness();
    if (readiness.ready) return null;
    return {
      id,
      error: `Database migrations ${readiness.state}; IPC method '${method}' is temporarily unavailable`,
      statusCode: 503,
      errorCode: "DB_MIGRATIONS_UNAVAILABLE",
      errorDetails: readiness,
    };
  }

  private buildErrorResponse(id: string, err: unknown): IpcResponse {
    if (err instanceof RouteError) {
      const response: IpcResponse = {
        id,
        error: err.message,
        statusCode: err.statusCode,
        errorCode: err.code,
      };
      if (err.details !== undefined) {
        response.errorDetails = err.details;
      }
      return response;
    }
    return { id, error: String(err) };
  }

  /**
   * Route a handler result to the appropriate send path:
   * - IpcStreamingResponse → chunked binary frames
   * - IpcBinaryResponse → single binary frame with content-length
   * - A raw binary/stream result (RouteResponse, Uint8Array, ...) → structured
   *   BINARY_UNSUPPORTED_OVER_IPC error (the transport can't carry it as JSON)
   * - Everything else → JSON response
   */
  private sendResult(
    socket: Socket,
    reader: IpcFrameReader,
    requestId: string,
    value: unknown,
  ): void {
    if (isIpcStreamingResponse(value)) {
      this.sendStreamingResponse(socket, reader, requestId, value);
    } else if (isIpcBinaryResponse(value)) {
      const envelope: IpcResponse = {
        id: requestId,
        headers: {
          ...value.headers,
          "content-length": String(value.binary.byteLength),
        },
      };
      this.sendResponse(socket, reader, envelope, value.binary);
    } else if (isNonJsonIpcResult(value)) {
      // A binary/streaming handler result (e.g. a file-content RouteResponse
      // wrapping a Bun.file) cannot be carried as a JSON `result`. Report a
      // structured error instead of silently serializing it into garbage; the
      // gateway IPC proxy treats this code as a signal to retry over HTTP,
      // which streams binary correctly.
      this.sendResponse(socket, reader, {
        id: requestId,
        error:
          "Binary/streaming responses are not supported over the IPC transport; use HTTP",
        statusCode: 421,
        errorCode: "BINARY_UNSUPPORTED_OVER_IPC",
      });
    } else {
      this.sendResponse(socket, reader, { id: requestId, result: value });
    }
  }

  /**
   * Pipe a ReadableStream as chunked binary frames over IPC.
   *
   * Wire format:
   *   [JSON envelope: { id, headers: { "transfer-encoding": "chunked", ... } }]
   *   [chunk frame 1]
   *   [chunk frame 2]
   *   ...
   *   [zero-length terminator]
   */
  private sendStreamingResponse(
    socket: Socket,
    reader: IpcFrameReader,
    requestId: string,
    response: IpcStreamingResponse,
  ): void {
    if (socket.destroyed) {
      this.abortControllers.get(requestId)?.abort();
      this.abortControllers.delete(requestId);
      return;
    }

    // Legacy clients can't handle chunked streaming — fall back to
    // buffering the full stream and sending as a single binary response.
    if (reader.isLegacy) {
      this.bufferAndSendStream(socket, reader, requestId, response);
      return;
    }

    const envelope: IpcResponse = {
      id: requestId,
      headers: {
        ...response.headers,
        "transfer-encoding": "chunked",
      },
    };
    writeMessage(socket, envelope);

    const streamReader = response.stream.getReader();
    const pump = (): void => {
      streamReader
        .read()
        .then(({ done, value }) => {
          if (socket.destroyed) {
            this.abortControllers.get(requestId)?.abort();
            this.abortControllers.delete(requestId);
            streamReader.cancel().catch(() => {});
            return;
          }
          if (done) {
            this.abortControllers.delete(requestId);
            writeStreamEnd(socket);
            return;
          }
          writeStreamChunk(socket, value);
          pump();
        })
        .catch((err) => {
          this.abortControllers.delete(requestId);
          log.warn({ err }, "IPC stream read error");
          if (!socket.destroyed) {
            writeStreamEnd(socket);
          }
        });
    };
    pump();
  }

  /**
   * Legacy fallback: buffer the entire stream, then send as a single
   * binary response with content-length.
   */
  private bufferAndSendStream(
    socket: Socket,
    reader: IpcFrameReader,
    requestId: string,
    response: IpcStreamingResponse,
  ): void {
    const chunks: Uint8Array[] = [];
    const streamReader = response.stream.getReader();

    const pump = (): void => {
      streamReader
        .read()
        .then(({ done, value }) => {
          if (done) {
            this.abortControllers.delete(requestId);
            const totalLength = chunks.reduce(
              (sum, c) => sum + c.byteLength,
              0,
            );
            const merged = new Uint8Array(totalLength);
            let offset = 0;
            for (const c of chunks) {
              merged.set(c, offset);
              offset += c.byteLength;
            }
            const envelope: IpcResponse = {
              id: requestId,
              headers: {
                ...response.headers,
                "content-length": String(totalLength),
              },
            };
            this.sendResponse(socket, reader, envelope, merged);
            return;
          }
          chunks.push(value);
          pump();
        })
        .catch((err) => {
          this.abortControllers.delete(requestId);
          log.warn({ err }, "IPC legacy stream buffer error");
          this.sendResponse(socket, reader, {
            id: requestId,
            error: "Stream read failed",
          });
        });
    };
    pump();
  }

  private sendResponse(
    socket: Socket,
    reader: IpcFrameReader,
    response: IpcResponse,
    binary?: Uint8Array,
  ): void {
    if (socket.destroyed) {
      return;
    }
    if (reader.isLegacy) {
      writeLegacyMessage(socket, response);
    } else {
      writeMessage(socket, response, binary);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an IPC caller's identity headers, mirroring what the HTTP adapter
 * derives from the verified `AuthContext`: `x-vellum-principal-type` and a
 * synthetic `x-vellum-actor-principal-id` for the local guardian. Handlers read
 * the resolved identity from `headers` (the single source of truth across both
 * transports); they never trust the request body.
 *
 * Principal type comes from the gateway-forwarded `x-vellum-principal-type`,
 * else `svc_gateway` for a gateway-proxied request (marked by
 * `x-vellum-proxy-server: ipc`, which a direct CLI never sends), else `local`.
 * Routes that elevate trust gate on `local`, so a remote caller arriving with
 * no verified principal must resolve to `svc_gateway`, never `local`.
 */
export function injectLocalActorHeader(
  params: Record<string, unknown> | undefined,
): RouteHandlerArgs {
  const args = (params ?? {}) as RouteHandlerArgs;
  const existingHeaders = args.headers;
  const forwardedPrincipal = existingHeaders?.["x-vellum-principal-type"] as
    | PrincipalType
    | undefined;
  const isGatewayProxied = existingHeaders?.["x-vellum-proxy-server"] === "ipc";
  const headers: Record<string, string> = {
    ...existingHeaders,
    "x-vellum-principal-type":
      forwardedPrincipal ?? (isGatewayProxied ? "svc_gateway" : "local"),
  };

  // Fill the local guardian's actor id for direct callers that lack one.
  // Defensive: the lookup queries the contacts table, which may not exist on a
  // very early boot path or in test fixtures without a DB — a failure must not
  // block dispatch, so routes requiring the header fail-closed on their own.
  if (!headers["x-vellum-actor-principal-id"]) {
    try {
      const localActor = findLocalGuardianPrincipalIdFromStore();
      if (localActor) {
        headers["x-vellum-actor-principal-id"] = localActor;
      }
    } catch (err) {
      log.debug(
        { err },
        "failed to resolve local actor principal for IPC header injection",
      );
    }
  }

  return { ...args, headers };
}

// ── Process-level singleton ───────────────────────────────────────────────

let instance: AssistantIpcServer | null = null;

function isEaddrInUse(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
}

/**
 * Start the daemon's CLI IPC server.
 *
 * Throws on EADDRINUSE: another daemon already holds the socket, so this
 * process must abort startup rather than run as an unmanageable duplicate
 * (invisible to health checks, unreachable by stop commands) while its
 * background jobs hit the shared database. Any other bind failure is non-fatal
 * — startup continues with degraded CLI connectivity.
 */
export async function startCliIpcServer(): Promise<void> {
  instance = new AssistantIpcServer();
  try {
    await instance.start();
  } catch (err) {
    if (isEaddrInUse(err)) {
      log.error(
        { err },
        "CLI IPC socket already in use by another daemon — aborting startup to prevent duplicate processing",
      );
      throw err;
    }
    log.warn(
      { err },
      "CLI IPC server failed to start — continuing startup with degraded CLI connectivity",
    );
  }
}

/** Stop the CLI IPC server during daemon shutdown. */
export function stopCliIpcServer(): void {
  instance?.stop();
  instance = null;
}

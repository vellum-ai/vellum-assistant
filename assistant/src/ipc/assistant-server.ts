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

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import { RouteError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/index.js";
import type { RouteDefinition } from "../runtime/routes/types.js";
import { getLogger } from "../util/logger.js";
import {
  type IpcEnvelope,
  IpcFrameReader,
  writeLegacyMessage,
  writeMessage,
  writeStreamChunk,
  writeStreamEnd,
} from "./ipc-framing.js";
import { type DbProxyParams, handleDbProxy } from "./routes/db-proxy.js";
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

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class AssistantIpcServer {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private methods = new Map<string, RouteDefinition["handler"]>();
  private socketPath: string;

  constructor() {
    const resolution = resolveIpcSocketPath("assistant");
    this.socketPath = resolution.path;
    log.info(
      { source: resolution.source, path: resolution.path },
      "Assistant IPC socket path resolved",
    );
    for (const route of routeDefinitionsToIpcMethods(ROUTES)) {
      this.methods.set(route.operationId, route.handler);
    }

    // ⚠️  TEMPORARY — gateway→assistant DB proxy (see ipc/routes/db-proxy.ts).
    // Remove once contacts/guardian-binding logic is fully migrated to the
    // gateway's own database.
    this.methods.set("db_proxy", (params) =>
      handleDbProxy(params as unknown as DbProxyParams),
    );
  }

  /** Start listening on the Unix domain socket. */
  async start(): Promise<void> {
    // Ensure the parent directory exists before listening.
    const socketDir = dirname(this.socketPath);
    if (!existsSync(socketDir)) {
      mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    }

    // Probe before unlink so a second daemon can't silently orphan an active
    // listener (Unix lets you unlink a still-bound socket file). See
    // `ensureSocketPathFree` for the behavior matrix.
    await ensureSocketPathFree(this.socketPath);

    this.server = createServer((socket) => {
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

    this.server.on("error", (err) => {
      log.error({ err }, "Assistant IPC server error");
    });

    this.server.listen(this.socketPath, () => {
      log.info({ path: this.socketPath }, "Assistant IPC server listening");
    });
  }

  /** Stop the server and disconnect all clients. */
  stop(): void {
    for (const client of this.clients) {
      if (!client.destroyed) client.destroy();
    }
    this.clients.clear();

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

  // ── Internal ──────────────────────────────────────────────────────────

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

    void binary;

    try {
      const result = handler(req.params ?? {});

      if (result instanceof Promise) {
        result
          .then((value) => {
            this.sendResult(socket, reader, req.id, value);
          })
          .catch((err) => {
            log.warn({ err, method: req.method }, "IPC handler error");
            this.sendResponse(
              socket,
              reader,
              this.buildErrorResponse(req.id, err),
            );
          });
      } else {
        this.sendResult(socket, reader, req.id, result);
      }
    } catch (err) {
      log.warn({ err, method: req.method }, "IPC handler error");
      this.sendResponse(socket, reader, this.buildErrorResponse(req.id, err));
    }
  }

  private buildErrorResponse(id: string, err: unknown): IpcResponse {
    if (err instanceof RouteError) {
      return {
        id,
        error: err.message,
        statusCode: err.statusCode,
        errorCode: err.code,
      };
    }
    return { id, error: String(err) };
  }

  /**
   * Route a handler result to the appropriate send path:
   * - IpcStreamingResponse → chunked binary frames
   * - IpcBinaryResponse → single binary frame with content-length
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
    if (socket.destroyed) return;

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
            streamReader.cancel().catch(() => {});
            return;
          }
          if (done) {
            writeStreamEnd(socket);
            return;
          }
          writeStreamChunk(socket, value);
          pump();
        })
        .catch((err) => {
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
    if (socket.destroyed) return;
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

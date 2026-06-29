/**
 * Local-mode CES Unix socket server.
 *
 * In local mode CES is spawned by the assistant and serves the spawning parent
 * over stdio. To support a multiprocess assistant daemon — where sibling
 * processes also need to reach CES — local mode additionally listens on a Unix
 * socket. The socket stays bound and accepts connections concurrently; each
 * connection is served by its own `CesRpcServer` over the shared (and
 * connection-safe) handler registry.
 *
 * Trust model: possession of the socket is the authorization boundary. Any
 * process able to open the socket is treated as one of the assistant's own
 * processes. The socket lives under the CES-private local data directory, whose
 * filesystem permissions gate access — CES performs no per-connection
 * authentication. (The normative statement of this boundary lives in
 * `credential-executor/AGENTS.md`.)
 */

import { mkdirSync, unlinkSync } from "node:fs";
import { createServer as createNetServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";

import { CesRpcServer, type RpcHandlerRegistry } from "./server.js";

/**
 * Wrap an accepted Unix socket as the readable/writable stream pair the
 * `CesRpcServer` consumes. Mirrors the wrapping used by the managed sidecar.
 */
export function socketToStreams(socket: Socket): {
  readable: Readable;
  writable: Writable;
} {
  const readable = new Readable({
    read() {
      // Data is pushed from the socket's "data" events.
    },
  });

  const writable = new Writable({
    write(chunk, _encoding, callback) {
      if (socket.writable) {
        socket.write(chunk, callback);
      } else {
        callback(new Error("Socket no longer writable"));
      }
    },
  });

  socket.on("data", (chunk) => {
    readable.push(chunk);
  });
  socket.on("end", () => {
    readable.push(null);
  });
  socket.on("error", (err) => {
    readable.destroy(err);
    writable.destroy(err);
  });

  return { readable, writable };
}

export interface LocalSocketServerOptions {
  /** Filesystem path to bind the Unix socket at. */
  socketPath: string;
  /** Shared RPC handler registry (connection-safe; reused per connection). */
  handlers: RpcHandlerRegistry;
  /** Abort signal — closes the listener and tears down live connections. */
  signal: AbortSignal;
  /** Logger for per-connection RPC servers. Defaults to console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
  /** Invoked once the socket is listening. */
  onListening?: (socketPath: string) => void;
  /** Invoked when the listener (not a single connection) errors. */
  onServerError?: (err: unknown) => void;
}

/**
 * Bind a Unix socket and serve every accepted connection with its own
 * `CesRpcServer`. The socket stays bound for the process lifetime (multi
 * accept); it is unlinked on startup (to clear a stale path) and again when the
 * signal aborts.
 *
 * Returns synchronously after starting the listen; serving happens via event
 * callbacks. A transport error on one connection is isolated and never affects
 * the others or the process.
 */
export function startLocalSocketServer(opts: LocalSocketServerOptions): void {
  const { socketPath, handlers, signal, logger, onListening, onServerError } =
    opts;

  mkdirSync(dirname(socketPath), { recursive: true });
  // Clear any stale socket file from a previous run.
  try {
    unlinkSync(socketPath);
  } catch {
    // File may not exist — that's fine.
  }

  const netServer = createNetServer();

  netServer.on("error", (err) => {
    onServerError?.(err);
  });

  netServer.on("connection", (socket: Socket) => {
    const { readable, writable } = socketToStreams(socket);
    const server = new CesRpcServer({
      input: readable,
      output: writable,
      handlers,
      logger,
      signal,
      // Local mode reads API keys from env/store directly — no-op so
      // update_managed_credential is still registered and returns success.
      onApiKeyUpdate: () => {},
    });

    // Each connection serves independently. serve() rejects on a transport
    // error (e.g. the peer crashes); contain it so one connection's failure
    // doesn't take down the listener or the process.
    void server.serve().catch((err) => {
      server.close();
      onServerError?.(err);
    });
  });

  netServer.listen(socketPath, () => {
    onListening?.(socketPath);
  });

  signal.addEventListener(
    "abort",
    () => {
      netServer.close();
      try {
        unlinkSync(socketPath);
      } catch {
        // Already removed.
      }
    },
    { once: true },
  );
}

#!/usr/bin/env bun
/**
 * Managed CES entrypoint.
 *
 * In managed (sidecar) mode the CES container:
 *
 * 1. Ensures the CES-private data directories exist.
 * 2. Binds a bootstrap Unix socket on the shared bootstrap volume.
 * 3. Accepts exactly **one** assistant runtime connection.
 * 4. Unlinks the socket path immediately after the connection is accepted,
 *    preventing any second process from connecting.
 * 5. Serves RPC on the accepted stream only.
 * 6. Simultaneously serves health probes (`/healthz`, `/readyz`) on a
 *    dedicated HTTP port for Kubernetes liveness/readiness checks.
 *
 * The managed entrypoint never opens a generic TCP or HTTP command API.
 * All RPC traffic flows exclusively over the accepted Unix socket stream.
 */

import { mkdirSync, unlinkSync } from "node:fs";
import { createServer as createNetServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";

import { CES_PROTOCOL_VERSION } from "@vellumai/ces-contracts";

import {
  getBootstrapSocketPath,
  getCesAuditDir,
  getCesDataRoot,
  getCesGrantsDir,
  getCesToolStoreDir,
  getHealthPort,
} from "./paths.js";
import { CesRpcServer, type RpcHandlerRegistry } from "./server.js";

// ---------------------------------------------------------------------------
// Logging (managed always logs to stderr)
// ---------------------------------------------------------------------------

const log = (msg: string) =>
  process.stderr.write(`[ces-managed] ${msg}\n`);

const warn = (msg: string) =>
  process.stderr.write(`[ces-managed] WARN: ${msg}\n`);

// ---------------------------------------------------------------------------
// Data directory bootstrap
// ---------------------------------------------------------------------------

function ensureDataDirs(): void {
  const dirs = [
    getCesDataRoot("managed"),
    getCesGrantsDir("managed"),
    getCesAuditDir("managed"),
    getCesToolStoreDir("managed"),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Stub RPC handlers (real implementations added in subsequent PRs)
// ---------------------------------------------------------------------------

const handlers: RpcHandlerRegistry = {};

// ---------------------------------------------------------------------------
// Health server
// ---------------------------------------------------------------------------

let rpcConnected = false;

function startHealthServer(port: number, signal: AbortSignal): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return new Response(
          JSON.stringify({ status: "ok", version: CES_PROTOCOL_VERSION }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/readyz") {
        const ready = rpcConnected;
        return new Response(
          JSON.stringify({ ready, version: CES_PROTOCOL_VERSION }),
          {
            status: ready ? 200 : 503,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  signal.addEventListener("abort", () => {
    server.stop(true);
  }, { once: true });

  return server;
}

// ---------------------------------------------------------------------------
// Bootstrap socket server (accepts exactly one connection)
// ---------------------------------------------------------------------------

/**
 * Listen on a Unix socket, accept exactly one connection, unlink the
 * socket path, and return readable/writable streams for the accepted
 * connection.
 */
function acceptOneConnection(
  socketPath: string,
  signal: AbortSignal,
): Promise<{ readable: Readable; writable: Writable; socket: Socket }> {
  return new Promise((resolve, reject) => {
    // Ensure the socket directory exists
    mkdirSync(dirname(socketPath), { recursive: true });

    // Clean up any stale socket file
    try {
      unlinkSync(socketPath);
    } catch {
      // Ignore — file may not exist
    }

    const netServer = createNetServer();

    const cleanup = () => {
      netServer.close();
      try {
        unlinkSync(socketPath);
      } catch {
        // Already unlinked or never created
      }
    };

    if (signal.aborted) {
      reject(new Error("Aborted before listening"));
      return;
    }

    signal.addEventListener("abort", () => {
      cleanup();
      reject(new Error("Aborted while waiting for connection"));
    }, { once: true });

    netServer.on("error", (err) => {
      cleanup();
      reject(err);
    });

    netServer.listen(socketPath, () => {
      log(`Bootstrap socket listening at ${socketPath}`);
    });

    netServer.on("connection", (socket: Socket) => {
      // Accept exactly one connection, then close the listener and
      // unlink the socket path so no other process can connect.
      log("Assistant connected via bootstrap socket");
      netServer.close();
      try {
        unlinkSync(socketPath);
      } catch {
        // Already unlinked
      }
      log("Bootstrap socket unlinked (single-connection enforced)");

      const readable = new Readable({
        read() {
          // Data is pushed externally
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

      resolve({ readable, writable, socket });
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  ensureDataDirs();

  log(`Starting CES v${CES_PROTOCOL_VERSION} (managed mode)`);

  const controller = new AbortController();

  // Graceful shutdown
  const shutdown = () => {
    log("Shutting down...");
    controller.abort();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Start health server on dedicated port
  const healthPort = getHealthPort();
  const healthServer = startHealthServer(healthPort, controller.signal);
  log(`Health server listening on port ${healthPort}`);

  // Wait for exactly one assistant connection on the bootstrap socket
  const socketPath = getBootstrapSocketPath();
  log(`Waiting for assistant connection on ${socketPath}...`);

  let connection: Awaited<ReturnType<typeof acceptOneConnection>>;
  try {
    connection = await acceptOneConnection(socketPath, controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      log("Shutdown before assistant connected.");
      return;
    }
    throw err;
  }

  rpcConnected = true;

  const server = new CesRpcServer({
    input: connection.readable,
    output: connection.writable,
    handlers,
    logger: {
      log: (msg: string, ...args: unknown[]) =>
        process.stderr.write(`[ces-managed] ${msg} ${args.map(String).join(" ")}\n`),
      warn: (msg: string, ...args: unknown[]) =>
        process.stderr.write(`[ces-managed] WARN: ${msg} ${args.map(String).join(" ")}\n`),
      error: (msg: string, ...args: unknown[]) =>
        process.stderr.write(`[ces-managed] ERROR: ${msg} ${args.map(String).join(" ")}\n`),
    },
    signal: controller.signal,
  });

  await server.serve();

  rpcConnected = false;
  log("RPC session ended. Shutting down...");
  controller.abort();
}

main().catch((err) => {
  process.stderr.write(`[ces-managed] Fatal: ${err}\n`);
  process.exit(1);
});

/**
 * CES process manager.
 *
 * Manages the CES child process lifecycle for local mode, and creates
 * transport connections for managed sidecar mode.
 *
 * Local mode: Spawns the `credential-executor` binary as a child process
 * and creates a stdio-based CesTransport for the RPC client. The manager
 * owns the process lifecycle (start, health monitoring, graceful shutdown).
 *
 * Managed mode: Connects to the CES sidecar's bootstrap Unix socket and
 * creates a socket-based CesTransport. The CES sidecar manages its own
 * lifecycle; the process manager only manages the transport connection.
 */

import { createConnection, type Socket } from "node:net";

import type { Subprocess } from "bun";

import { getLogger } from "../util/logger.js";
import type { CesTransport } from "./client.js";
import {
  discoverCes,
  type DiscoveryResult,
  type LocalDiscoverySuccess,
  type ManagedDiscoverySuccess,
} from "./executable-discovery.js";

const log = getLogger("ces-process-manager");

const SHUTDOWN_GRACE_MS = 5_000;
const SOCKET_CONNECT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Process manager state
// ---------------------------------------------------------------------------

export interface CesProcessManager {
  /**
   * Start the CES process (local) or connect to the sidecar (managed).
   * Returns a CesTransport ready for use with createCesClient().
   *
   * Throws if CES is unavailable.
   */
  start(): Promise<CesTransport>;

  /** Gracefully stop the CES process (local) or disconnect (managed). */
  stop(): Promise<void>;

  /** The discovery result from the last start() call, or null if not started. */
  getDiscoveryResult(): DiscoveryResult | null;

  /** Whether the process manager is currently running. */
  isRunning(): boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCesProcessManager(): CesProcessManager {
  let childProcess: Subprocess | null = null;
  let managedSocket: Socket | null = null;
  let discoveryResult: DiscoveryResult | null = null;
  let running = false;

  return {
    async start(): Promise<CesTransport> {
      if (running) {
        throw new Error("CES process manager is already running");
      }

      discoveryResult = await discoverCes();

      if (discoveryResult.mode === "unavailable") {
        throw new CesUnavailableError(discoveryResult.reason);
      }

      if (discoveryResult.mode === "local") {
        const transport = await startLocalProcess(discoveryResult);
        running = true;
        return transport;
      }

      // managed mode
      const transport = await connectManagedSocket(discoveryResult);
      running = true;
      return transport;
    },

    async stop(): Promise<void> {
      if (!running) return;

      if (childProcess) {
        await stopLocalProcess(childProcess);
        childProcess = null;
      }

      if (managedSocket) {
        managedSocket.destroy();
        managedSocket = null;
      }

      running = false;
      log.info("CES process manager stopped");
    },

    getDiscoveryResult(): DiscoveryResult | null {
      return discoveryResult;
    },

    isRunning(): boolean {
      return running;
    },
  };

  // -------------------------------------------------------------------------
  // Local mode — child process over stdio
  // -------------------------------------------------------------------------

  async function startLocalProcess(
    discovery: LocalDiscoverySuccess,
  ): Promise<CesTransport> {
    log.info(
      { executable: discovery.executablePath },
      "Spawning CES child process",
    );

    const proc = Bun.spawn({
      cmd: [discovery.executablePath],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: {
        ...process.env,
        // Signal to CES that it was launched by the assistant
        CES_LAUNCHED_BY: "assistant",
      },
    });

    childProcess = proc;

    log.info({ pid: proc.pid }, "CES child process started");

    return createStdioTransport(proc);
  }

  // -------------------------------------------------------------------------
  // Managed mode — Unix socket connection
  // -------------------------------------------------------------------------

  async function connectManagedSocket(
    discovery: ManagedDiscoverySuccess,
  ): Promise<CesTransport> {
    log.info(
      { socketPath: discovery.socketPath },
      "Connecting to managed CES sidecar",
    );

    const socket = await connectWithTimeout(
      discovery.socketPath,
      SOCKET_CONNECT_TIMEOUT_MS,
    );
    managedSocket = socket;

    log.info("Connected to managed CES sidecar");

    return createSocketTransport(socket);
  }
}

// ---------------------------------------------------------------------------
// Stdio transport (local mode)
// ---------------------------------------------------------------------------

function createStdioTransport(proc: Subprocess): CesTransport {
  const messageHandlers: Array<(message: string) => void> = [];
  let buffer = "";
  let alive = true;

  // Read stdout line by line — narrow past `number` union arm from Subprocess type
  if (proc.stdout && typeof proc.stdout !== "number") {
    const reader = proc.stdout.getReader();

    void (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += new TextDecoder().decode(value);
          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (line) {
              for (const handler of messageHandlers) {
                handler(line);
              }
            }
          }
        }
      } catch {
        // Process ended
      } finally {
        alive = false;
      }
    })();
  }

  // Track process exit
  proc.exited.then(() => {
    alive = false;
  });

  return {
    write(line: string): void {
      if (!alive || !proc.stdin || typeof proc.stdin === "number") {
        throw new Error("CES stdio transport is not alive");
      }
      proc.stdin.write(line + "\n");
    },

    onMessage(handler: (message: string) => void): void {
      messageHandlers.push(handler);
    },

    isAlive(): boolean {
      return alive;
    },

    close(): void {
      alive = false;
      if (proc.stdin && typeof proc.stdin !== "number") {
        proc.stdin.end();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Socket transport (managed mode)
// ---------------------------------------------------------------------------

function createSocketTransport(socket: Socket): CesTransport {
  const messageHandlers: Array<(message: string) => void> = [];
  let buffer = "";
  let alive = true;

  socket.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line) {
        for (const handler of messageHandlers) {
          handler(line);
        }
      }
    }
  });

  socket.on("close", () => {
    alive = false;
  });

  socket.on("error", (err) => {
    log.warn({ err }, "CES socket transport error");
    alive = false;
  });

  return {
    write(line: string): void {
      if (!alive || socket.destroyed) {
        throw new Error("CES socket transport is not alive");
      }
      socket.write(line + "\n");
    },

    onMessage(handler: (message: string) => void): void {
      messageHandlers.push(handler);
    },

    isAlive(): boolean {
      return alive && !socket.destroyed;
    },

    close(): void {
      alive = false;
      socket.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function stopLocalProcess(proc: Subprocess): Promise<void> {
  log.info({ pid: proc.pid }, "Stopping CES child process");
  proc.kill("SIGTERM");

  const graceful = await Promise.race([
    proc.exited.then(() => true),
    new Promise<false>((resolve) =>
      setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS),
    ),
  ]);

  if (!graceful) {
    log.warn("CES child process did not exit gracefully, sending SIGKILL");
    proc.kill("SIGKILL");
    await proc.exited;
  }

  log.info("CES child process stopped");
}

function connectWithTimeout(
  socketPath: string,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `Connection to CES socket at ${socketPath} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** CES is not available in the current deployment (executable or socket missing). */
export class CesUnavailableError extends Error {
  constructor(reason: string) {
    super(`CES is unavailable: ${reason}`);
    this.name = "CesUnavailableError";
  }
}

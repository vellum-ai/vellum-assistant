/**
 * CES process manager.
 *
 * Creates transport connections to the CES process — either a CLI-launched
 * sibling over a Unix socket (bare-metal/local), or a managed sidecar over
 * its bootstrap socket (containerized). The process manager owns only the
 * transport connection lifecycle; the CES process itself is managed by the
 * CLI (sibling) or the pod infrastructure (managed).
 *
 * Managed env contract:
 * - CES_BOOTSTRAP_SOCKET  — Path to the bootstrap Unix socket (shared emptyDir)
 * - /assistant-data-ro     — Assistant data mounted read-only into the CES sidecar
 * - /ces-data              — CES private data directory (separate PVC)
 * - CES_HEALTH_PORT        — Health check port exposed by the CES sidecar
 */

import { createConnection, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";

import type { AssistantConfig } from "../config/schema.js";
import { getLogger } from "../util/logger.js";
import type { CesTransport } from "./client.js";
import {
  discoverCesWithRetry,
  type DiscoveryResult,
  type ManagedDiscoverySuccess,
  type SiblingDiscoverySuccess,
} from "./executable-discovery.js";

const log = getLogger("ces-process-manager");

type PmLogger = ReturnType<typeof getLogger>;

const SOCKET_CONNECT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Well-known managed env paths
// ---------------------------------------------------------------------------

/**
 * Read-only mount point where the CES sidecar can read assistant data.
 * This is the assistant-data PVC mounted into the CES container as read-only.
 */
export const CES_ASSISTANT_DATA_READONLY_MOUNT = "/assistant-data-ro";

/**
 * Private data directory for the CES sidecar (separate PVC).
 * CES stores grants, audit logs, and credential material here.
 */
export const CES_PRIVATE_DATA_DIR = "/ces-data";

// ---------------------------------------------------------------------------
// Process manager configuration
// ---------------------------------------------------------------------------

export interface CesProcessManagerConfig {
  /**
   * Assistant configuration.
   * Reserved for future feature-flag checks or config-driven behavior.
   */
  assistantConfig?: AssistantConfig;

  /** Logger override. Defaults to the module logger; injected in tests. */
  logger?: PmLogger;
}

// ---------------------------------------------------------------------------
// Process manager state
// ---------------------------------------------------------------------------

export interface CesProcessManager {
  /**
   * Connect to the CES process (sibling socket or managed sidecar socket).
   * Returns a CesTransport ready for use with createCesClient().
   *
   * Throws if CES is unavailable.
   */
  start(): Promise<CesTransport>;

  /** Disconnect from the CES socket. */
  stop(): Promise<void>;

  /**
   * Force-disconnect the CES socket even if start() hasn't finished yet.
   */
  forceStop(): Promise<void>;

  /** The discovery result from the last start() call, or null if not started. */
  getDiscoveryResult(): DiscoveryResult | null;

  /** Whether the process manager is currently running. */
  isRunning(): boolean;

  /**
   * Register a callback that fires when the current transport dies. Lets
   * callers (e.g. ces-runtime.ts) start a proactive reconnect loop instead
   * of waiting for a lazy credential-op-triggered reconnection.
   */
  onTransportClose(handler: () => void): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCesProcessManager(
  config: CesProcessManagerConfig,
): CesProcessManager {
  const pmLog = config.logger ?? log;
  let managedSocket: Socket | null = null;
  let discoveryResult: DiscoveryResult | null = null;
  let running = false;
  let currentTransport: SocketTransport | null = null;
  const transportCloseHandlers: Array<() => void> = [];

  return {
    async start(): Promise<CesTransport> {
      if (running) {
        throw new Error("CES process manager is already running");
      }

      // Poll for the socket with a short backoff. Both the managed bootstrap
      // socket and the CLI-launched sibling socket are bound asynchronously,
      // so a reconnecting assistant can briefly race the re-bind.
      discoveryResult = await discoverCesWithRetry();

      if (discoveryResult.mode === "unavailable") {
        throw new CesUnavailableError(discoveryResult.reason);
      }

      // managed sidecar or CLI-launched sibling — both connect to a socket.
      const transport = await connectManagedSocket(discoveryResult);
      currentTransport = transport;
      wireTransportClose(transport);
      running = true;
      return transport;
    },

    async stop(): Promise<void> {
      if (!running) {
        return;
      }

      if (managedSocket) {
        // Mark the close as intentional so the transport-death log is debug,
        // not a misleading WARN, on routine shutdown/reconnect.
        currentTransport?.markClosing();
        managedSocket.destroy();
        managedSocket = null;
      }

      currentTransport = null;
      running = false;
      pmLog.info("CES process manager stopped");
    },

    async forceStop(): Promise<void> {
      if (managedSocket) {
        currentTransport?.markClosing();
        managedSocket.destroy();
        managedSocket = null;
      }

      currentTransport = null;
      running = false;
      pmLog.info("CES process manager force-stopped");
    },

    getDiscoveryResult(): DiscoveryResult | null {
      return discoveryResult;
    },

    isRunning(): boolean {
      return running;
    },

    onTransportClose(handler: () => void): void {
      transportCloseHandlers.push(handler);
      // If the current transport is already dead, fire immediately.
      if (currentTransport && !currentTransport.isAlive()) {
        handler();
      }
    },
  };

  // -------------------------------------------------------------------------
  // Wire the transport's onClose to all registered handlers
  // -------------------------------------------------------------------------

  function wireTransportClose(transport: CesTransport): void {
    transport.onClose?.(() => {
      for (const handler of transportCloseHandlers) {
        try {
          handler();
        } catch {
          // handler must never throw back into the transport
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // Socket connection — managed sidecar or CLI-launched local sibling
  // -------------------------------------------------------------------------

  async function connectManagedSocket(
    discovery: ManagedDiscoverySuccess | SiblingDiscoverySuccess,
  ): Promise<SocketTransport> {
    pmLog.info(
      { socketPath: discovery.socketPath, mode: discovery.mode },
      "Connecting to CES over socket",
    );

    const socket = await connectWithTimeout(
      discovery.socketPath,
      SOCKET_CONNECT_TIMEOUT_MS,
    );
    managedSocket = socket;

    pmLog.info("Connected to CES over socket");

    // Assign currentTransport synchronously here (no await between socket
    // assignment and this line) so stop()/forceStop() can always mark an
    // intentional close, even if they race the connect.
    const transport = createSocketTransport(socket, pmLog);
    currentTransport = transport;
    return transport;
  }
}

// ---------------------------------------------------------------------------
// Close notification (shared by both transports)
// ---------------------------------------------------------------------------

/**
 * Tracks the transport `alive` state and notifies registered handlers exactly
 * once when the transport dies, so the RPC client can fail-fast any in-flight
 * calls instead of waiting out their timeouts.
 *
 * `markClosing()` records that an imminent close was initiated by us (shutdown,
 * reconnect, handshake rejection). A close so marked logs at debug; an
 * unmarked death (remote socket close, socket error) logs at WARN.
 */
function createCloseNotifier(log: PmLogger): {
  isAlive: () => boolean;
  markClosing: () => void;
  markDead: (reason?: string) => void;
  onClose: (handler: () => void) => void;
} {
  let alive = true;
  let notified = false;
  let intentional = false;
  const handlers: Array<() => void> = [];
  return {
    isAlive: () => alive,
    markClosing() {
      intentional = true;
    },
    markDead(reason?: string) {
      alive = false;
      if (notified) {
        return;
      }
      notified = true;
      if (intentional) {
        log.debug(
          { reason: reason ?? "intentional" },
          "CES socket transport closed",
        );
      } else {
        log.warn(
          { reason: reason ?? "unknown" },
          "CES socket transport died unexpectedly; credential ops will fail over or reconnect",
        );
      }
      for (const handler of handlers) {
        try {
          handler();
        } catch {
          // a close handler must never throw back into the transport
        }
      }
    },
    onClose(handler) {
      handlers.push(handler);
    },
  };
}

// ---------------------------------------------------------------------------
// Socket transport (managed mode)
// ---------------------------------------------------------------------------

/**
 * A CesTransport plus `markClosing()`, which the process manager calls before
 * an intentional socket destroy so the ensuing close logs at debug, not WARN.
 */
interface SocketTransport extends CesTransport {
  markClosing(): void;
}

function createSocketTransport(socket: Socket, log: PmLogger): SocketTransport {
  const messageHandlers: Array<(message: string) => void> = [];
  let buffer = "";
  const death = createCloseNotifier(log);

  const decoder = new StringDecoder("utf8");

  socket.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
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
    death.markDead("socket closed");
  });

  socket.on("error", (err) => {
    log.warn({ err }, "CES socket transport error");
    death.markDead("socket error");
  });

  return {
    write(line: string): void {
      if (!death.isAlive() || socket.destroyed) {
        throw new Error("CES socket transport is not alive");
      }
      socket.write(line + "\n");
    },

    onMessage(handler: (message: string) => void): void {
      messageHandlers.push(handler);
    },

    isAlive(): boolean {
      return death.isAlive() && !socket.destroyed;
    },

    onClose: death.onClose,

    markClosing: death.markClosing,

    close(): void {
      death.markClosing();
      death.markDead("transport.close() called");
      socket.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function connectWithTimeout(
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

/** CES is not available in the current deployment (socket missing). */
export class CesUnavailableError extends Error {
  constructor(reason: string) {
    super(`CES is unavailable: ${reason}`);
    this.name = "CesUnavailableError";
  }
}

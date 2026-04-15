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
 *
 * Feature-flag gate: Managed sidecar mode is controlled by the
 * `ces-managed-sidecar` feature flag (checked via the required
 * AssistantConfig). When the flag is off, the process manager skips
 * managed discovery even in containerized environments, ensuring
 * rollback safety.
 *
 * Managed env contract:
 * - CES_BOOTSTRAP_SOCKET  — Path to the bootstrap Unix socket (shared emptyDir)
 * - /assistant-data-ro     — Assistant data mounted read-only into the CES sidecar
 * - /ces-data              — CES private data directory (separate PVC)
 * - CES_HEALTH_PORT        — Health check port exposed by the CES sidecar
 */

import { createConnection, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";

import type { Subprocess } from "bun";

import type { AssistantConfig } from "../config/schema.js";
import { ensureBun } from "../util/bun-runtime.js";
import { getLogger } from "../util/logger.js";
import type { CesTransport } from "./client.js";
import {
  discoverCes,
  discoverLocalCes,
  type DiscoveryResult,
  type LocalDiscoverySuccess,
  type LocalSourceDiscoverySuccess,
  type ManagedDiscoverySuccess,
} from "./executable-discovery.js";
import { isCesManagedSidecarEnabled } from "./feature-gates.js";

const log = getLogger("ces-process-manager");

const SHUTDOWN_GRACE_MS = 5_000;
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
   * Assistant configuration for feature-flag checks.
   * The managed sidecar path is gated behind the `ces-managed-sidecar`
   * feature flag via this config.  When omitted (e.g. CLI / admin
   * callers), managed mode is allowed unconditionally.
   */
  assistantConfig?: AssistantConfig;
}

// ---------------------------------------------------------------------------
// Process manager state
// ---------------------------------------------------------------------------

export interface CesProcessManager {
  /**
   * Start the CES process (local) or connect to the sidecar (managed).
   * Returns a CesTransport ready for use with createCesClient().
   *
   * When the `ces-managed-sidecar` feature flag is off, managed mode
   * is skipped even in containerized environments — the process manager
   * falls back to local discovery.
   *
   * Throws if CES is unavailable.
   */
  start(): Promise<CesTransport>;

  /** Gracefully stop the CES process (local) or disconnect (managed). */
  stop(): Promise<void>;

  /**
   * Force-stop the CES process even if start() hasn't finished yet.
   * Unlike stop(), this works regardless of the `running` state — it kills
   * any child process or destroys any managed socket immediately.
   */
  forceStop(): Promise<void>;

  /** The discovery result from the last start() call, or null if not started. */
  getDiscoveryResult(): DiscoveryResult | null;

  /** Whether the process manager is currently running. */
  isRunning(): boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCesProcessManager(
  config: CesProcessManagerConfig,
): CesProcessManager {
  let childProcess: Subprocess | null = null;
  let managedSocket: Socket | null = null;
  let discoveryResult: DiscoveryResult | null = null;
  let running = false;

  return {
    async start(): Promise<CesTransport> {
      if (running) {
        throw new Error("CES process manager is already running");
      }

      // Feature-flag gate: when the managed sidecar flag is off, skip
      // managed discovery entirely. This ensures rollback safety —
      // disabling the flag leaves existing non-agent platform consumers
      // intact.
      const managedAllowed = config.assistantConfig
        ? isCesManagedSidecarEnabled(config.assistantConfig)
        : true; // No config → allow managed mode unconditionally (CLI/admin callers)

      if (managedAllowed) {
        discoveryResult = await discoverCes();
        if (discoveryResult.mode === "unavailable") {
          // The managed sidecar bootstrap socket is not present — this happens
          // when the flag is enabled by default but the instance pre-dates the
          // socket volume mount (e.g. existing Docker configs without the
          // ces-bootstrap volume). Warn and fall back to local discovery so
          // these deployments don't fail on upgrade.
          log.warn(
            { reason: discoveryResult.reason },
            "CES managed sidecar bootstrap socket unavailable — falling back to local CES discovery",
          );
          discoveryResult = discoverLocalCes();
        }
      } else {
        log.info(
          "CES managed sidecar feature flag is off — skipping managed discovery, falling back to local",
        );
        discoveryResult = discoverLocalCes();
      }

      if (discoveryResult.mode === "unavailable") {
        throw new CesUnavailableError(discoveryResult.reason);
      }

      if (discoveryResult.mode === "local") {
        const transport = await startLocalProcess(discoveryResult);
        running = true;
        return transport;
      }

      if (discoveryResult.mode === "local-source") {
        const transport = await startLocalSourceProcess(discoveryResult);
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

    async forceStop(): Promise<void> {
      if (childProcess) {
        childProcess.kill("SIGKILL");
        await childProcess.exited.catch(() => {});
        childProcess = null;
      }

      if (managedSocket) {
        managedSocket.destroy();
        managedSocket = null;
      }

      running = false;
      log.info("CES process manager force-stopped");
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
      stderr: "pipe",
      env: {
        ...process.env,
        // Signal to CES that it was launched by the assistant
        CES_LAUNCHED_BY: "assistant",
      },
    });

    childProcess = proc;

    log.info({ pid: proc.pid }, "CES child process started");
    forwardStderrToLogger(proc);

    return createStdioTransport(proc);
  }

  // -------------------------------------------------------------------------
  // Local source mode — child process over stdio (bun run)
  // -------------------------------------------------------------------------

  async function startLocalSourceProcess(
    discovery: LocalSourceDiscoverySuccess,
  ): Promise<CesTransport> {
    log.info(
      { sourcePath: discovery.sourcePath },
      "Spawning CES child process from source",
    );

    const bunPath = await ensureBun();
    const proc = Bun.spawn({
      cmd: [bunPath, "run", discovery.sourcePath],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // Signal to CES that it was launched by the assistant
        CES_LAUNCHED_BY: "assistant",
      },
    });

    childProcess = proc;

    log.info({ pid: proc.pid }, "CES child process started (from source)");
    forwardStderrToLogger(proc);

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
    const decoder = new TextDecoder();

    void (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
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

function forwardStderrToLogger(proc: Subprocess): void {
  if (!proc.stderr || typeof proc.stderr === "number") return;

  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  void (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trimEnd();
          buffer = buffer.slice(newlineIdx + 1);
          if (line) log.error({ pid: proc.pid }, `[ces-stderr] ${line}`);
        }
      }
      const trailing = buffer.trimEnd();
      if (trailing) log.error({ pid: proc.pid }, `[ces-stderr] ${trailing}`);
    } catch {
      // Process ended or stream closed; nothing to forward.
    }
  })();
}

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

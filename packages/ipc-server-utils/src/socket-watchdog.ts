/**
 * Resilience helper for Unix-domain-socket IPC servers: re-binds the
 * listening socket when its on-disk path entry has been removed (e.g. by a
 * tmpfs sweep or rogue cleanup of `/run/*`).
 *
 * Existing connected sockets survive the re-bind because the kernel keeps
 * connection inodes alive independently of the listener path; only new
 * `connect()` calls require the path to exist.
 *
 * Consumers wire their `Server` reference into the watchdog via callbacks
 * rather than passing the server directly so the watchdog can guard against
 * shutdown/restart races mid-rebind.
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import type { Server } from "node:net";
import { dirname } from "node:path";

/**
 * Minimal logger surface (pino-compatible). Each method receives a context
 * object plus an optional human-readable message.
 */
export interface SocketWatchdogLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface SocketWatchdogOptions {
  /** Absolute path to the Unix socket file the consumer is listening on. */
  socketPath: string;
  /**
   * How often to stat the socket path. Set to `0` to disable. Defaults to
   * 5000ms.
   */
  intervalMs?: number;
  /**
   * Returns the consumer's current listening server. The watchdog uses this
   * both as a precondition (no rebind when null) and as a generation marker
   * to detect shutdown/restart races mid-rebind.
   */
  getServer: () => Server | null;
  /**
   * Factory for a fresh listening Server. Called by the watchdog when a
   * rebind is needed; the watchdog drives `.listen(socketPath)` and waits
   * for the `listening` event before installing.
   */
  createServer: () => Server;
  /**
   * Invoked when a rebind succeeds. The consumer is responsible for
   * swapping its primary server reference to `newServer` and disposing of
   * `oldServer` (typically by tracking it as a legacy listener while
   * in-flight clients drain, then closing it).
   */
  onRebind: (newServer: Server, oldServer: Server) => void;
  /** Pino-compatible logger. */
  log: SocketWatchdogLogger;
}

const DEFAULT_INTERVAL_MS = 5000;

/**
 * Ensure the directory containing `socketPath` exists. Created with mode
 * `0o700` so a freshly-spawned dir on a tmpfs mount doesn't leak the IPC
 * surface to other UIDs. Existing directories keep their permissions —
 * `mkdir` only applies the mode to directories it creates.
 */
export function ensureSocketDir(socketPath: string): void {
  const socketDir = dirname(socketPath);
  if (!existsSync(socketDir)) {
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Watchdog that periodically stats a Unix socket file and re-binds the
 * listener when the path has been removed.
 *
 * Lifecycle:
 *   - Construct with the consumer's callbacks.
 *   - Call {@link start} after the consumer's initial `listen()` succeeds.
 *   - Call {@link stop} during shutdown (before closing the underlying
 *     server) so an in-flight rebind doesn't resurrect the listener.
 *
 * The watchdog timer is `unref`-ed so it never keeps the event loop alive
 * on its own.
 */
export class SocketWatchdog {
  private readonly socketPath: string;
  private readonly intervalMs: number;
  private readonly getServer: () => Server | null;
  private readonly createServer: () => Server;
  private readonly onRebind: (newServer: Server, oldServer: Server) => void;
  private readonly log: SocketWatchdogLogger;

  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(options: SocketWatchdogOptions) {
    this.socketPath = options.socketPath;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.getServer = options.getServer;
    this.createServer = options.createServer;
    this.onRebind = options.onRebind;
    this.log = options.log;
  }

  /**
   * Begin polling the socket path. No-op if `intervalMs <= 0` or the
   * watchdog is already running.
   */
  start(): void {
    if (this.intervalMs <= 0 || this.handle !== null) return;
    this.handle = setInterval(() => {
      // The async entry path of rebindIfMissing performs filesystem work
      // (ensureSocketDir, createServer) before its inner try/catch, so a
      // synchronous throw — e.g. EACCES on a read-only fs — would surface
      // as an unhandled rejection on every tick. Catch here so the timer
      // stays quiet on persistent failure modes.
      this.rebindIfMissing().catch((err) => {
        this.log.error(
          { err, path: this.socketPath },
          "Watchdog rebind failed unexpectedly",
        );
      });
    }, this.intervalMs);
    this.handle.unref?.();
  }

  /** Stop the polling timer. Safe to call multiple times. */
  stop(): void {
    if (this.handle !== null) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  /**
   * Re-bind the listening socket if its path entry is missing on disk.
   *
   * Public for tests so the watchdog can be exercised deterministically
   * without waiting for the interval. Returns `true` when a re-bind was
   * performed, `false` when the socket was already healthy, the consumer
   * is not running, or a shutdown/restart raced the rebind.
   */
  async rebindIfMissing(): Promise<boolean> {
    const initialServer = this.getServer();
    if (initialServer === null) return false;
    if (existsSync(this.socketPath)) return false;

    this.log.warn(
      { path: this.socketPath },
      "IPC socket path missing on disk — re-binding listener",
    );

    ensureSocketDir(this.socketPath);

    const newServer = this.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: unknown) => {
          newServer.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          newServer.off("error", onError);
          resolve();
        };
        newServer.once("error", onError);
        newServer.once("listening", onListening);
        newServer.listen(this.socketPath);
      });
    } catch (err) {
      this.log.error(
        { err, path: this.socketPath },
        "Failed to re-bind IPC socket — will retry on next watchdog tick",
      );
      try {
        newServer.close();
      } catch {
        /* ignore */
      }
      return false;
    }

    // Race guard: while we were awaiting listen(), the consumer may have
    // stopped, restarted, or otherwise replaced its server reference.
    // Installing newServer would resurrect a listener after shutdown
    // (keeping the process alive and accepting IPC again). Discard the
    // new server instead.
    if (this.getServer() !== initialServer) {
      try {
        newServer.close();
      } catch {
        /* ignore */
      }
      // newServer.listen() recreated the path on disk. If our listen won
      // the race, the file is sitting there — clean it up so it doesn't
      // shadow a future start().
      if (existsSync(this.socketPath)) {
        try {
          unlinkSync(this.socketPath);
        } catch {
          /* ignore */
        }
      }
      this.log.warn(
        { path: this.socketPath },
        "IPC server state changed during rebind — discarded new listener",
      );
      return false;
    }

    this.onRebind(newServer, initialServer);

    this.log.info(
      { path: this.socketPath },
      "IPC socket re-bound after path loss",
    );
    return true;
  }
}

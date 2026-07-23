/**
 * Daemon-side client for the route host subprocess (`worker.ts`).
 *
 * Lazily spawns the host on first use (via the shared PID-file spawn helper),
 * holds one persistent socket connection, and forwards route invocations over
 * the IPC framing, correlating replies by envelope id.
 *
 * Reclamation is the whole point of using a subprocess: on a per-request
 * timeout the client **hard-kills** the host (`SIGKILL`) and rejects every
 * in-flight request, then respawns lazily on the next call. Unlike a worker
 * thread, a synchronously-wedged handler is genuinely reclaimed — the OS does
 * not care that the JS loop never yielded.
 *
 * Single host process for now: a sync-stalling handler blocks the host's loop
 * until the timeout kills it, so concurrent in-flight requests are collateral
 * (they reject as retryable). A pool of hosts to isolate route-from-route is a
 * follow-up; the daemon stays responsive regardless.
 */

import { existsSync, unlinkSync } from "node:fs";
import { connect, type Socket } from "node:net";

import type { IpcEnvelope } from "../ipc/ipc-framing.js";
import { IpcFrameReader, writeMessage } from "../ipc/ipc-framing.js";
import { getLogger } from "../util/logger.js";
import { getProcPidPath, getProcSocketPath } from "../util/platform.js";
import { spawnWorkerProcess } from "../util/worker-process.js";
import {
  ROUTE_HOST_PROC_NAME,
  ROUTE_INVOKE_METHOD,
  type RouteInvokeParams,
  type RouteInvokeResult,
} from "./route-host-protocol.js";

const log = getLogger("route-host-client");

/** Default per-request timeout before the host is hard-killed. */
const DEFAULT_INVOKE_TIMEOUT_MS = 30_000;

/** The handler timed out; the host was killed. Maps to a 504. */
export class RouteHostTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`route handler timed out after ${timeoutMs}ms`);
    this.name = "RouteHostTimeoutError";
  }
}

/** The host died / connection dropped with this request in flight. Retryable → 503. */
export class RouteHostUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteHostUnavailableError";
  }
}

export interface RouteInvokeResponse {
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Uint8Array | null;
}

interface Pending {
  resolve: (value: RouteInvokeResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RouteHostClientOptions {
  /** Per-request timeout in ms. Default 30_000. */
  readonly invokeTimeoutMs?: number;
  /** Override the worker entry URL (tests). */
  readonly workerEntryUrl?: URL;
}

export class RouteHostClient {
  private readonly invokeTimeoutMs: number;
  private readonly workerEntryUrl: URL;
  private readonly socketPath = getProcSocketPath(ROUTE_HOST_PROC_NAME);
  private readonly pidPath = getProcPidPath(ROUTE_HOST_PROC_NAME);

  private socket: Socket | undefined;
  private connecting: Promise<Socket> | undefined;
  private pid: number | undefined;
  private readonly pending = new Map<string, Pending>();
  private idSeq = 0;

  constructor(options?: RouteHostClientOptions) {
    this.invokeTimeoutMs =
      options?.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
    this.workerEntryUrl =
      options?.workerEntryUrl ?? new URL("./worker.ts", import.meta.url);
  }

  /**
   * Run one route invocation on the host. Resolves with the handler's
   * response; rejects with {@link RouteHostTimeoutError} on timeout (host is
   * killed) or {@link RouteHostUnavailableError} if the host is unreachable.
   */
  async invoke(
    params: RouteInvokeParams,
    body: Uint8Array | null,
  ): Promise<RouteInvokeResponse> {
    const socket = await this.ensureConnected();
    const id = String(++this.idSeq);

    return new Promise<RouteInvokeResponse>((resolve, reject) => {
      const timer = setTimeout(() => this.onTimeout(id), this.invokeTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });

      const envelope: IpcEnvelope = {
        id,
        method: ROUTE_INVOKE_METHOD,
        params: params as unknown as Record<string, unknown>,
      };
      if (body && body.byteLength > 0) {
        envelope.headers = { "content-length": String(body.byteLength) };
        writeMessage(socket, envelope, body);
      } else {
        writeMessage(socket, envelope);
      }
    });
  }

  /** Kill the host (if any) and reject all in-flight requests. */
  dispose(): void {
    this.killHost("dispose");
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private async ensureConnected(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) {
      return this.socket;
    }
    if (!this.connecting) {
      this.connecting = this.spawnAndConnect().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  private async spawnAndConnect(): Promise<Socket> {
    const { pid } = await spawnWorkerProcess({
      pidPath: this.pidPath,
      entry: this.workerEntryUrl,
      workerLabel: "Route host",
      // Owned by the daemon (appears in its process tree, torn down with it);
      // kill it if it hangs during startup so a failed spawn leaves nothing.
      options: { detached: false, terminateOnTimeout: true },
    });
    this.pid = pid;

    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(this.socketPath);
      s.once("connect", () => resolve(s));
      s.once("error", (err) =>
        reject(new RouteHostUnavailableError(`connect failed: ${err.message}`)),
      );
    });

    const reader = new IpcFrameReader(
      (envelope, binary) => this.onMessage(envelope, binary),
      (err) => log.warn({ err }, "Route host client framing error"),
    );
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    // Identity-guard the teardown handlers: a late `close` from a socket we
    // already replaced (e.g. one we killed on timeout) must not tear down the
    // successor connection.
    socket.on("close", () => this.onSocketClosed(socket, "socket closed"));
    socket.on("error", (err) =>
      this.onSocketClosed(socket, `socket error: ${err.message}`),
    );

    this.socket = socket;
    return socket;
  }

  private onMessage(
    envelope: IpcEnvelope,
    binary: Uint8Array | undefined,
  ): void {
    if (!envelope.id) {
      return;
    }
    const pending = this.pending.get(envelope.id);
    if (!pending) {
      return;
    }
    this.pending.delete(envelope.id);
    clearTimeout(pending.timer);

    if (envelope.error != null) {
      pending.reject(new Error(envelope.error));
      return;
    }
    const result = envelope.result as RouteInvokeResult | undefined;
    if (!result) {
      pending.reject(new Error("route host returned no result"));
      return;
    }
    pending.resolve({
      status: result.status,
      headers: result.headers,
      body: binary ?? null,
    });
  }

  private onTimeout(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    log.error(
      { id, pid: this.pid, timeoutMs: this.invokeTimeoutMs },
      "Route handler timed out — hard-killing route host",
    );
    // Kill first (rejects collateral in-flight as unavailable), then report the
    // timeout for this specific request.
    this.killHost("invoke timeout");
    pending.reject(new RouteHostTimeoutError(this.invokeTimeoutMs));
  }

  /**
   * A socket closed or errored. Ignore it unless it's still the active socket —
   * a stale predecessor (killed on timeout) closing late must not disturb a
   * successor connection.
   */
  private onSocketClosed(socket: Socket, reason: string): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    this.rejectAllPending(new RouteHostUnavailableError(reason));
  }

  private killHost(reason: string): void {
    if (this.pid != null) {
      try {
        process.kill(this.pid, "SIGKILL");
      } catch {
        // already gone
      }
      this.pid = undefined;
    }
    // Clear the reference before destroying so the resulting `close` event is
    // treated as stale by onSocketClosed (which reads `this.socket`).
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
    // Remove the PID/socket files so the next spawn can't race a not-yet-reaped
    // SIGKILL: without this, the liveness probe may briefly still see the dead
    // PID as alive and reuse it (`alreadyRunning`), pointing us at a dead socket.
    for (const path of [this.pidPath, this.socketPath]) {
      if (existsSync(path)) {
        try {
          unlinkSync(path);
        } catch {
          // best-effort
        }
      }
    }
    this.rejectAllPending(
      new RouteHostUnavailableError(`route host killed (${reason})`),
    );
  }

  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}

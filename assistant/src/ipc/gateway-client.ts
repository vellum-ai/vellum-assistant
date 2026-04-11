/**
 * Assistant-side IPC client for communicating with the gateway.
 *
 * Connects to the gateway's Unix domain socket and provides typed methods
 * for reading gateway-owned data. Also receives server-pushed events so the
 * daemon can react to state changes (e.g. feature flag updates).
 *
 * Protocol: newline-delimited JSON (same as gateway/src/ipc/server.ts).
 */

import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";

const log = getLogger("gateway-ipc-client");

// ---------------------------------------------------------------------------
// Types (mirror gateway/src/ipc/server.ts protocol)
// ---------------------------------------------------------------------------

type IpcRequest = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

type IpcResponse = {
  id: string;
  result?: unknown;
  error?: string;
};

type IpcEvent = {
  event: string;
  data?: unknown;
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const DEFAULT_CALL_TIMEOUT_MS = 5_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export class GatewayIpcClient extends EventEmitter {
  private socket: Socket | null = null;
  private socketPath: string;
  private pendingCalls = new Map<string, PendingCall>();
  private nextId = 1;
  private buffer = "";
  private connected = false;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;

  constructor(socketPath?: string) {
    super();
    this.socketPath = socketPath ?? getDefaultSocketPath();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Connect to the gateway IPC socket. Automatically reconnects on
   * disconnect until `stop()` is called.
   */
  connect(): void {
    this.stopped = false;
    this.doConnect();
  }

  /** Disconnect and stop reconnecting. */
  stop(): void {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending calls
    for (const [id, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error("IPC client stopped"));
      this.pendingCalls.delete(id);
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    this.connected = false;
  }

  /** Whether the client is currently connected. */
  isConnected(): boolean {
    return this.connected;
  }

  // ── RPC ───────────────────────────────────────────────────────────────

  /**
   * Call a method on the gateway IPC server.
   * Returns the result or throws on error / timeout.
   */
  async call(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.connected || !this.socket || this.socket.destroyed) {
      throw new Error("IPC client not connected");
    }

    const id = String(this.nextId++);
    const req: IpcRequest = { id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id);
        reject(new Error(`IPC call timed out: ${method}`));
      }, timeoutMs);

      this.pendingCalls.set(id, { resolve, reject, timer });
      this.socket!.write(JSON.stringify(req) + "\n");
    });
  }

  // ── Typed helpers ─────────────────────────────────────────────────────

  async getFeatureFlags(): Promise<Record<string, boolean>> {
    const result = await this.call("getFeatureFlags");
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return result as Record<string, boolean>;
    }
    return {};
  }

  async getFeatureFlag(flag: string): Promise<boolean | null> {
    const result = await this.call("getFeatureFlag", { flag });
    if (typeof result === "boolean") return result;
    return null;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private doConnect(): void {
    if (this.stopped) return;

    const socket = connect(this.socketPath);
    this.socket = socket;

    socket.on("connect", () => {
      this.connected = true;
      this.reconnectDelay = RECONNECT_BASE_MS;
      this.buffer = "";
      log.info({ path: this.socketPath }, "Connected to gateway IPC");
      this.emit("connected");
    });

    socket.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trim();
        this.buffer = this.buffer.slice(newlineIdx + 1);
        if (line) {
          this.handleMessage(line);
        }
      }
    });

    socket.on("close", () => {
      this.connected = false;
      this.socket = null;

      // Reject all pending calls — they can never receive a response
      for (const [id, pending] of this.pendingCalls) {
        clearTimeout(pending.timer);
        pending.reject(new Error("IPC socket closed"));
        this.pendingCalls.delete(id);
      }

      if (!this.stopped) {
        log.debug(
          { delayMs: this.reconnectDelay },
          "Gateway IPC disconnected, scheduling reconnect",
        );
        this.scheduleReconnect();
      }
    });

    socket.on("error", (err) => {
      // ENOENT / ECONNREFUSED are expected if gateway hasn't started yet
      if (
        (err as NodeJS.ErrnoException).code !== "ENOENT" &&
        (err as NodeJS.ErrnoException).code !== "ECONNREFUSED"
      ) {
        log.warn({ err }, "Gateway IPC socket error");
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      this.doConnect();
    }, this.reconnectDelay);
  }

  private handleMessage(line: string): void {
    let msg: IpcResponse | IpcEvent;
    try {
      msg = JSON.parse(line);
    } catch {
      log.warn("Received invalid JSON from gateway IPC");
      return;
    }

    // Server-pushed event (no id field)
    if ("event" in msg && typeof (msg as IpcEvent).event === "string") {
      const evt = msg as IpcEvent;
      this.emit(evt.event, evt.data);
      return;
    }

    // RPC response
    const resp = msg as IpcResponse;
    if (!resp.id) return;

    const pending = this.pendingCalls.get(resp.id);
    if (!pending) return;

    this.pendingCalls.delete(resp.id);
    clearTimeout(pending.timer);

    if (resp.error) {
      pending.reject(new Error(resp.error));
    } else {
      pending.resolve(resp.result);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: GatewayIpcClient | null = null;

/**
 * Get the shared gateway IPC client instance.
 *
 * The client is created lazily and auto-connects. Call `stopGatewayIpcClient()`
 * during shutdown to clean up.
 */
export function getGatewayIpcClient(): GatewayIpcClient {
  if (!_instance) {
    _instance = new GatewayIpcClient();
    _instance.connect();
  }
  return _instance;
}

/** Stop and discard the shared client (for shutdown / testing). */
export function stopGatewayIpcClient(): void {
  if (_instance) {
    _instance.stop();
    _instance = null;
  }
}

/** Reset the singleton for testing. */
export function _resetGatewayIpcClientForTesting(): void {
  _instance = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDefaultSocketPath(): string {
  const workspaceDir =
    process.env.VELLUM_WORKSPACE_DIR?.trim() ||
    join(
      process.env.BASE_DATA_DIR?.trim() || (process.env.HOME ?? "/tmp"),
      ".vellum",
      "workspace",
    );
  return join(workspaceDir, "gateway.sock");
}

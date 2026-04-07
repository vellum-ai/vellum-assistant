/**
 * WebSocket server for the Chrome extension relay bridge.
 *
 * Holds a single active extension connection. Commands are sent as JSON
 * and matched to pending Promises by UUID.
 */

import type { ServerWebSocket } from "bun";

import { getLogger } from "../util/logger.js";
import type {
  ExtensionCommand,
  ExtensionHeartbeat,
  ExtensionInboundMessage,
  ExtensionResponse,
} from "./protocol.js";

const log = getLogger("browser-extension-relay");

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

interface PendingCommand {
  resolve: (value: ExtensionResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BrowserRelayWebSocketData {
  wsType: "browser-relay";
  connectionId: string;
  /**
   * Guardian identity derived from the JWT claims at WebSocket upgrade
   * time. Used by the ChromeExtensionRegistry (runtime/) to route
   * host_browser_request frames to the correct extension. Undefined when
   * HTTP auth is disabled (dev bypass) or when the token's sub cannot be
   * parsed into an actor principal.
   */
  guardianId?: string;
}

export interface ExtensionRelayStatus {
  connected: boolean;
  connectionId: string | null;
  lastHeartbeatAt: number | null;
  pendingCommandCount: number;
}

/**
 * Manages the single active Chrome extension WebSocket connection and
 * dispatches commands to it.
 */
export class ExtensionRelayServer {
  private ws: ServerWebSocket<BrowserRelayWebSocketData> | null = null;
  private connectionId: string | null = null;
  private lastHeartbeatAt: number | null = null;
  private pendingCommands = new Map<string, PendingCommand>();

  // ── WebSocket lifecycle ────────────────────────────────────────────

  handleOpen(ws: ServerWebSocket<BrowserRelayWebSocketData>): void {
    const newId = ws.data.connectionId;

    if (this.ws) {
      log.warn(
        { oldConnectionId: this.connectionId, newConnectionId: newId },
        "Browser extension relay: new connection displaced an existing one",
      );
      try {
        this.ws.close(1001, "Displaced by new connection");
      } catch {
        // best-effort
      }
      this.rejectAllPending(
        new Error("Extension reconnected — previous commands cancelled"),
      );
    }

    this.ws = ws;
    this.connectionId = newId;
    log.info({ connectionId: newId }, "Browser extension relay connected");
  }

  handleMessage(
    ws: ServerWebSocket<BrowserRelayWebSocketData>,
    raw: string,
  ): void {
    let msg: ExtensionInboundMessage;
    try {
      msg = JSON.parse(raw) as ExtensionInboundMessage;
    } catch {
      log.warn(
        { connectionId: ws.data.connectionId },
        "Browser extension relay: failed to parse message",
      );
      return;
    }

    if ("type" in msg && msg.type === "heartbeat") {
      this.handleHeartbeat(msg);
      return;
    }

    // Otherwise it's a command response
    const response = msg as ExtensionResponse;
    const pending = this.pendingCommands.get(response.id);
    if (!pending) {
      log.warn(
        { id: response.id },
        "Browser extension relay: received response for unknown command id",
      );
      return;
    }

    clearTimeout(pending.timer);
    this.pendingCommands.delete(response.id);
    pending.resolve(response);
  }

  handleClose(
    ws: ServerWebSocket<BrowserRelayWebSocketData>,
    code: number,
    reason?: string,
  ): void {
    const closedId = ws.data.connectionId;
    if (this.connectionId !== closedId) {
      // Stale close for a displaced connection — ignore
      return;
    }

    log.info(
      { connectionId: closedId, code, reason },
      "Browser extension relay disconnected",
    );
    this.ws = null;
    this.connectionId = null;
    this.rejectAllPending(new Error(`Extension disconnected (code=${code})`));
  }

  // ── Command dispatch ───────────────────────────────────────────────

  /**
   * Send a command to the extension and wait for its response.
   */
  sendCommand(
    command: Omit<ExtensionCommand, "id">,
    timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<ExtensionResponse> {
    if (!this.ws) {
      return Promise.reject(new Error("Browser extension is not connected"));
    }

    const id = crypto.randomUUID();
    const fullCommand: ExtensionCommand = { ...command, id };

    return new Promise<ExtensionResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(
          new Error(
            `Browser extension command timed out after ${timeoutMs}ms (action=${command.action})`,
          ),
        );
      }, timeoutMs);

      this.pendingCommands.set(id, { resolve, reject, timer });

      try {
        this.ws!.send(JSON.stringify(fullCommand));
      } catch (err) {
        clearTimeout(timer);
        this.pendingCommands.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ── Status ─────────────────────────────────────────────────────────

  getStatus(): ExtensionRelayStatus {
    return {
      connected: !!this.ws,
      connectionId: this.connectionId,
      lastHeartbeatAt: this.lastHeartbeatAt,
      pendingCommandCount: this.pendingCommands.size,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────

  private handleHeartbeat(msg: ExtensionHeartbeat): void {
    this.lastHeartbeatAt = Date.now();
    log.debug(
      {
        extensionVersion: msg.extensionVersion,
        connectedTabs: msg.connectedTabs,
      },
      "Browser extension heartbeat received",
    );
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pendingCommands.delete(id);
    }
  }
}

/** Module-level singleton — imported by http-server and client. */
export const extensionRelayServer = new ExtensionRelayServer();

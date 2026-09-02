/**
 * Pumps raw RFB bytes between one `/v1/desktop/stream` WebSocket and the
 * desktop's VNC server on localhost.
 *
 * The socket is a pure byte pipe: every frame in both directions is binary
 * RFB data, and outcomes are signaled with close codes only (1008 feature
 * disabled, 1013 busy, 1011 desktop failed or stopped, 1001 shutting down).
 * The gateway relays close codes but not pre-upgrade HTTP statuses, which is
 * why a disabled feature is reported after the upgrade rather than as a 404.
 */

import {
  type DesktopSessionManager,
  type DesktopViewer,
  getDesktopSessionManager,
} from "./desktop-session-manager.js";

/** Frames a client may send before the VNC socket is up; RFB handshakes are tiny. */
const MAX_PENDING_BYTES = 1024 * 1024;

export interface DesktopStreamClientSocket {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface DesktopTcpSocket {
  /** Returns the bytes accepted; fewer than offered means backpressure. */
  write(data: Uint8Array): number;
  end(): void;
}

export interface DesktopTcpHandlers {
  onData(data: Uint8Array): void;
  onDrain(): void;
  onClose(): void;
  onError(err: Error): void;
}

export type DesktopTcpConnect = (
  port: number,
  handlers: DesktopTcpHandlers,
) => Promise<DesktopTcpSocket>;

export interface DesktopStreamBridgeOptions {
  /** Whether this daemon serves the desktop at all. Defaults to enabled. */
  readonly enabled?: boolean;
  readonly manager?: DesktopSessionManager;
  readonly connect?: DesktopTcpConnect;
}

export class DesktopStreamBridge {
  private readonly ws: DesktopStreamClientSocket;
  private readonly enabled: boolean;
  private readonly manager: DesktopSessionManager;
  private readonly connect: DesktopTcpConnect;
  private readonly viewer: DesktopViewer;

  private tcp: DesktopTcpSocket | null = null;
  /** Client bytes waiting on the VNC socket, or on backpressure once it is up. */
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private closed = false;
  private ownsSlot = false;

  constructor(
    ws: DesktopStreamClientSocket,
    options: DesktopStreamBridgeOptions = {},
  ) {
    this.ws = ws;
    this.enabled = options.enabled ?? true;
    this.manager = options.manager ?? getDesktopSessionManager();
    this.connect = options.connect ?? connectToVnc;
    this.viewer = {
      onDesktopLost: (reason) => this.fail(1011, `Desktop stopped: ${reason}`),
    };
  }

  /** Claim the viewer slot, start the desktop, and dial its VNC port. */
  async start(): Promise<void> {
    if (!this.enabled) {
      this.fail(1008, "Desktop is not available on this assistant");
      return;
    }
    const slot = this.manager.acquireViewerSlot(this.viewer);
    if (!slot.ok) {
      if (slot.reason === "busy") {
        this.fail(1013, "Desktop is in use by another viewer");
      } else {
        this.fail(1001, "The assistant is shutting down");
      }
      return;
    }
    this.ownsSlot = true;

    let vncPort: number;
    try {
      ({ vncPort } = await this.manager.ensureDesktopRunning());
    } catch {
      this.fail(1011, "Desktop failed to start");
      return;
    }
    if (this.closed) {
      return;
    }

    let tcp: DesktopTcpSocket;
    try {
      tcp = await this.connect(vncPort, {
        onData: (data) => this.ws.send(data),
        onDrain: () => this.flush(),
        onClose: () => this.fail(1011, "Desktop connection closed"),
        onError: () => this.fail(1011, "Desktop connection failed"),
      });
    } catch {
      this.fail(1011, "Desktop connection failed");
      return;
    }
    if (this.closed) {
      tcp.end();
      return;
    }
    this.tcp = tcp;
    this.flush();
  }

  handleClientFrame(message: string | Uint8Array | ArrayBuffer): void {
    if (this.closed || typeof message === "string") {
      return;
    }
    const bytes =
      message instanceof ArrayBuffer ? new Uint8Array(message) : message;
    if (this.pendingBytes + bytes.byteLength > MAX_PENDING_BYTES) {
      this.fail(1009, "Desktop stream backlog exceeded");
      return;
    }
    this.pending.push(bytes);
    this.pendingBytes += bytes.byteLength;
    this.flush();
  }

  /** The client socket closed; the caller has already seen the close frame. */
  handleClose(): void {
    this.release();
  }

  private flush(): void {
    const tcp = this.tcp;
    if (!tcp) {
      return;
    }
    while (this.pending.length > 0) {
      const chunk = this.pending[0]!;
      const written = tcp.write(chunk);
      if (written < 0) {
        this.fail(1011, "Desktop connection closed");
        return;
      }
      this.pendingBytes -= written;
      if (written < chunk.byteLength) {
        this.pending[0] = chunk.subarray(written);
        return;
      }
      this.pending.shift();
    }
  }

  private fail(code: number, reason: string): void {
    if (this.closed) {
      return;
    }
    this.release();
    this.ws.close(code, reason);
  }

  private release(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.pending = [];
    this.pendingBytes = 0;
    this.tcp?.end();
    this.tcp = null;
    if (this.ownsSlot) {
      this.ownsSlot = false;
      this.manager.releaseViewerSlot(this.viewer);
    }
  }
}

const connectToVnc: DesktopTcpConnect = async (port, handlers) =>
  Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data: (_socket, data) => handlers.onData(data),
      drain: () => handlers.onDrain(),
      close: () => handlers.onClose(),
      error: (_socket, err) => handlers.onError(err),
      connectError: (_socket, err) => handlers.onError(err),
    },
  });

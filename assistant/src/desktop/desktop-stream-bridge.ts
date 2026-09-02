/**
 * Pumps raw RFB bytes between one `/v1/desktop/stream` WebSocket and the
 * desktop's VNC server on loopback. Every frame is binary RFB data; outcomes
 * are signaled with close codes only (see `DESKTOP_CLOSE`).
 */

import {
  connectLoopback,
  DESKTOP_CLOSE,
  DESKTOP_VNC_PORT,
  type DesktopSessionManager,
  type DesktopTcpHandlers,
  type DesktopTcpSocket,
  type DesktopViewer,
  getDesktopSessionManager,
} from "./desktop-session-manager.js";

/** Frames a client may send before the VNC socket is up; RFB handshakes are tiny. */
const MAX_PENDING_BYTES = 1024 * 1024;

interface DesktopStreamClientSocket {
  /** Bun's `ServerWebSocket.send`: `0` means the frame was dropped. */
  send(data: Uint8Array): number;
  close(code?: number, reason?: string): void;
}

interface DesktopStreamBridgeOptions {
  readonly manager?: DesktopSessionManager;
  readonly connect?: (
    port: number,
    handlers: DesktopTcpHandlers,
  ) => Promise<DesktopTcpSocket>;
}

export class DesktopStreamBridge {
  private readonly ws: DesktopStreamClientSocket;
  private readonly manager: DesktopSessionManager;
  private readonly connect: NonNullable<DesktopStreamBridgeOptions["connect"]>;
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
    this.manager = options.manager ?? getDesktopSessionManager();
    this.connect = options.connect ?? connectLoopback;
    this.viewer = {
      onDesktopLost: ({ code, reason }) => this.fail(code, reason),
    };
  }

  /** Claim the viewer slot, start the desktop, and dial its VNC port. */
  async start(): Promise<void> {
    const slot = this.manager.acquireViewerSlot(this.viewer);
    if (!slot.ok) {
      if (slot.reason === "busy") {
        this.fail(DESKTOP_CLOSE.busy, "Desktop is in use by another viewer");
      } else {
        this.fail(DESKTOP_CLOSE.goingAway, "The assistant is shutting down");
      }
      return;
    }
    this.ownsSlot = true;

    try {
      await this.manager.ensureDesktopRunning();
    } catch {
      this.fail(DESKTOP_CLOSE.failed, "Desktop failed to start");
      return;
    }
    if (this.closed) {
      return;
    }

    let tcp: DesktopTcpSocket;
    try {
      tcp = await this.connect(DESKTOP_VNC_PORT, {
        onData: (data) => {
          if (this.ws.send(data) === 0) {
            this.fail(DESKTOP_CLOSE.failed, "Viewer too slow");
          }
        },
        onDrain: () => this.flush(),
        onClose: () =>
          this.fail(DESKTOP_CLOSE.failed, "Desktop connection closed"),
        onError: () =>
          this.fail(DESKTOP_CLOSE.failed, "Desktop connection failed"),
      });
    } catch {
      this.fail(DESKTOP_CLOSE.failed, "Desktop connection failed");
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
      this.fail(DESKTOP_CLOSE.failed, "Desktop stream backlog exceeded");
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
        this.fail(DESKTOP_CLOSE.failed, "Desktop connection closed");
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

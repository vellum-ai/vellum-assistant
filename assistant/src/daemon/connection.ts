import * as net from 'node:net';
import type { ServerMessage } from './ipc-protocol.js';
import { serialize } from './ipc-protocol.js';

/**
 * Generic IPC connection interface that abstracts the transport layer.
 * Allows the daemon to support both Unix sockets and HTTP-based connections
 * without changing handler logic.
 */
export interface IpcConnection {
  /** Unique identifier for this connection */
  readonly id: string;

  /** Whether the connection has been destroyed/closed */
  readonly isDestroyed: boolean;

  /** Send a message to the client */
  send(msg: ServerMessage): void;

  /** Register a handler to be called when the connection closes */
  onClose(handler: () => void): void;

  /** Destroy/close the connection */
  destroy(): void;
}

/**
 * IPC connection implementation backed by a Unix domain socket.
 */
export class SocketIpcConnection implements IpcConnection {
  private closeHandlers: Array<() => void> = [];
  private closed = false;

  constructor(
    private socket: net.Socket,
    public readonly id: string,
  ) {
    // Wire up the close event
    this.socket.on('close', () => {
      this.closed = true;
      for (const handler of this.closeHandlers) {
        handler();
      }
    });
  }

  get isDestroyed(): boolean {
    return this.socket.destroyed || this.closed;
  }

  send(msg: ServerMessage): void {
    if (!this.isDestroyed) {
      this.socket.write(serialize(msg));
    }
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
    // If already closed, call immediately
    if (this.closed) {
      handler();
    }
  }

  destroy(): void {
    this.socket.destroy();
  }

  /**
   * Get the underlying socket for operations that still need direct access.
   * This is a temporary bridge during the transition to full abstraction.
   */
  getSocket(): net.Socket {
    return this.socket;
  }
}

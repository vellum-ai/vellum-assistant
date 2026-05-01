import type { OutgoingHttpHeaders } from "node:http";

import {
  binaryLikeToBytes,
  buildLoopbackWebSocketUrl,
  closeWebSocket,
  decodeBase64Bytes,
  encodeBase64,
  websocketHeadersFromVelay,
} from "./bridge-utils.js";
import {
  VELAY_FRAME_TYPES,
  VELAY_WEBSOCKET_MESSAGE_TYPES,
  type VelayFrame,
  type VelayWebSocketCloseFrame,
  type VelayWebSocketInboundFrame,
  type VelayWebSocketMessageFrame,
  type VelayWebSocketOpenErrorFrame,
  type VelayWebSocketOpenedFrame,
  type VelayWebSocketOpenFrame,
} from "./protocol.js";

const MAX_PENDING_MESSAGES = 100;
const textFrameDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

type PendingMessage = string | Uint8Array;

type WebSocketConstructorWithHeaders = {
  new (
    url: string,
    options?: {
      headers?: OutgoingHttpHeaders;
      protocols?: string | string[];
    },
  ): WebSocket;
};

type BridgeConnection = {
  ws: WebSocket;
  opened: boolean;
  openErrorSent: boolean;
  pendingMessages: PendingMessage[];
  suppressNextCloseFrame: boolean;
};

type SendVelayFrame = (frame: VelayFrame) => void;

export class VelayWebSocketBridge {
  private readonly connections = new Map<string, BridgeConnection>();

  constructor(
    private readonly gatewayLoopbackBaseUrl: string,
    private readonly sendFrame: SendVelayFrame,
  ) {}

  handleFrame(frame: VelayWebSocketInboundFrame): void {
    switch (frame.type) {
      case VELAY_FRAME_TYPES.websocketOpen:
        this.open(frame);
        return;
      case VELAY_FRAME_TYPES.websocketMessage:
        this.message(frame);
        return;
      case VELAY_FRAME_TYPES.websocketClose:
        this.close(frame);
        return;
    }
  }

  open(frame: VelayWebSocketOpenFrame): void {
    this.closeExisting(frame.connection_id);

    const url = buildLoopbackWebSocketUrl(
      this.gatewayLoopbackBaseUrl,
      frame.path,
      frame.raw_query,
    );
    if (!url) {
      this.sendOpenError(frame.connection_id, "Invalid WebSocket path");
      return;
    }

    let ws: WebSocket;
    try {
      const WebSocketWithHeaders =
        WebSocket as unknown as WebSocketConstructorWithHeaders;
      ws = new WebSocketWithHeaders(url, {
        headers: websocketHeadersFromVelay(frame.headers),
        ...(frame.subprotocol ? { protocols: [frame.subprotocol] } : {}),
      });
    } catch {
      this.sendOpenError(frame.connection_id, "WebSocket connection failed");
      return;
    }

    const connection: BridgeConnection = {
      ws,
      opened: false,
      openErrorSent: false,
      pendingMessages: [],
      suppressNextCloseFrame: false,
    };
    this.connections.set(frame.connection_id, connection);

    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => {
      if (this.connections.get(frame.connection_id) !== connection) return;

      connection.opened = true;
      this.sendFrame({
        type: VELAY_FRAME_TYPES.websocketOpened,
        connection_id: frame.connection_id,
      } satisfies VelayWebSocketOpenedFrame);

      for (const message of connection.pendingMessages) {
        ws.send(message);
      }
      connection.pendingMessages = [];
    });

    ws.addEventListener("message", (event) => {
      void this.forwardLocalMessage(
        frame.connection_id,
        connection,
        event.data,
      );
    });

    ws.addEventListener("close", (event) => {
      this.handleLocalClose(frame.connection_id, connection, event);
    });

    ws.addEventListener("error", () => {
      if (connection.opened) return;
      this.failOpeningConnection(
        frame.connection_id,
        connection,
        "WebSocket connection failed",
      );
    });
  }

  message(frame: VelayWebSocketMessageFrame): void {
    const connection = this.connections.get(frame.connection_id);
    if (!connection) return;

    const message = decodeVelayMessage(frame);
    if (message === undefined) {
      this.closeConnection(
        frame.connection_id,
        connection,
        1003,
        "Invalid message",
      );
      return;
    }

    if (connection.opened && connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.send(message);
      return;
    }

    if (connection.pendingMessages.length >= MAX_PENDING_MESSAGES) {
      this.closeConnection(
        frame.connection_id,
        connection,
        1008,
        "Buffer overflow",
      );
      return;
    }
    connection.pendingMessages.push(message);
  }

  close(frame: VelayWebSocketCloseFrame): void {
    const connection = this.connections.get(frame.connection_id);
    if (!connection) return;

    connection.suppressNextCloseFrame = true;
    this.closeConnection(
      frame.connection_id,
      connection,
      frame.code,
      frame.reason,
    );
  }

  closeAll(code = 1001, reason = "Tunnel closed"): void {
    for (const [connectionId, connection] of this.connections) {
      connection.suppressNextCloseFrame = true;
      this.closeConnection(connectionId, connection, code, reason);
    }
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  private async forwardLocalMessage(
    connectionId: string,
    connection: BridgeConnection,
    data: unknown,
  ): Promise<void> {
    if (this.connections.get(connectionId) !== connection) return;

    const message = await encodeLocalMessage(connectionId, data);
    if (this.connections.get(connectionId) !== connection) return;
    this.sendFrame(message);
  }

  private handleLocalClose(
    connectionId: string,
    connection: BridgeConnection,
    event: CloseEvent,
  ): void {
    if (this.connections.get(connectionId) !== connection) return;
    this.connections.delete(connectionId);
    connection.pendingMessages = [];

    if (!connection.opened) {
      this.sendOpenErrorOnce(
        connectionId,
        connection,
        "WebSocket connection failed",
      );
      return;
    }

    if (connection.suppressNextCloseFrame) return;
    this.sendFrame({
      type: VELAY_FRAME_TYPES.websocketClose,
      connection_id: connectionId,
      code: event.code,
      reason: event.reason,
    } satisfies VelayWebSocketCloseFrame);
  }

  private failOpeningConnection(
    connectionId: string,
    connection: BridgeConnection,
    reason: string,
  ): void {
    if (this.connections.get(connectionId) === connection) {
      this.connections.delete(connectionId);
    }
    connection.pendingMessages = [];
    this.sendOpenErrorOnce(connectionId, connection, reason);
    closeWebSocket(connection.ws);
  }

  private closeExisting(connectionId: string): void {
    const existing = this.connections.get(connectionId);
    if (!existing) return;
    existing.suppressNextCloseFrame = true;
    this.closeConnection(connectionId, existing, 1000, "Replaced");
  }

  private closeConnection(
    connectionId: string,
    connection: BridgeConnection,
    code?: number,
    reason?: string,
  ): void {
    if (this.connections.get(connectionId) === connection) {
      this.connections.delete(connectionId);
    }
    connection.pendingMessages = [];
    closeWebSocket(connection.ws, code, reason);
  }

  private sendOpenError(connectionId: string, reason: string): void {
    this.sendFrame({
      type: VELAY_FRAME_TYPES.websocketOpenError,
      connection_id: connectionId,
      reason,
    } satisfies VelayWebSocketOpenErrorFrame);
  }

  private sendOpenErrorOnce(
    connectionId: string,
    connection: BridgeConnection,
    reason: string,
  ): void {
    if (connection.openErrorSent) return;
    connection.openErrorSent = true;
    this.sendOpenError(connectionId, reason);
  }
}

function decodeVelayMessage(
  frame: VelayWebSocketMessageFrame,
): PendingMessage | undefined {
  const bytes = decodeBase64Bytes(frame.body_base64 ?? "");
  if (bytes === undefined) return undefined;

  if (frame.message_type === VELAY_WEBSOCKET_MESSAGE_TYPES.text) {
    return textFrameDecoder.decode(bytes);
  }
  if (frame.message_type === VELAY_WEBSOCKET_MESSAGE_TYPES.binary) {
    return bytes;
  }
  return undefined;
}

async function encodeLocalMessage(
  connectionId: string,
  data: unknown,
): Promise<VelayWebSocketMessageFrame> {
  if (typeof data === "string") {
    return {
      type: VELAY_FRAME_TYPES.websocketMessage,
      connection_id: connectionId,
      message_type: VELAY_WEBSOCKET_MESSAGE_TYPES.text,
      body_base64: encodeBase64(data),
    };
  }

  return {
    type: VELAY_FRAME_TYPES.websocketMessage,
    connection_id: connectionId,
    message_type: VELAY_WEBSOCKET_MESSAGE_TYPES.binary,
    body_base64: encodeBase64(await binaryLikeToBytes(data)),
  };
}

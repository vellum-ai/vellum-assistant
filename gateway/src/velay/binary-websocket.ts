const HEADER_SIZE = 33;
const connectionIdDecoder = new TextDecoder();
const connectionIdPattern = /^[0-9a-f]{32}$/;

export const VELAY_BINARY_WEBSOCKET_HEADER = "X-Vellum-Velay-Binary-WebSocket";

export interface VelayBinaryWebSocketFrame {
  type: "websocket_binary";
  connection_id: string;
  payload: Uint8Array;
}

// Wire format: version byte 1, 32 lowercase hex connection-ID bytes, payload.
export function encodeBinaryWebSocketFrame(
  frame: VelayBinaryWebSocketFrame,
): Uint8Array {
  if (!connectionIdPattern.test(frame.connection_id)) {
    throw new Error("Invalid binary WebSocket connection ID");
  }
  const bytes = new Uint8Array(HEADER_SIZE + frame.payload.byteLength);
  bytes[0] = 1;
  for (let i = 0; i < 32; i++) {
    bytes[i + 1] = frame.connection_id.charCodeAt(i);
  }
  bytes.set(frame.payload, HEADER_SIZE);
  return bytes;
}

export function decodeBinaryWebSocketFrame(
  bytes: Uint8Array,
): VelayBinaryWebSocketFrame | undefined {
  if (bytes.byteLength < HEADER_SIZE || bytes[0] !== 1) {
    return undefined;
  }
  const connectionId = connectionIdDecoder.decode(
    bytes.subarray(1, HEADER_SIZE),
  );
  if (!connectionIdPattern.test(connectionId)) {
    return undefined;
  }
  return {
    type: "websocket_binary",
    connection_id: connectionId,
    payload: bytes.subarray(HEADER_SIZE),
  };
}

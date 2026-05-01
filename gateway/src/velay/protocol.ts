import { Buffer } from "node:buffer";

import { z } from "zod";

export const VELAY_TUNNEL_SUBPROTOCOL = "velay-tunnel-v1";

export const VELAY_FRAME_TYPES = {
  registered: "registered",
  httpRequest: "http_request",
  httpResponse: "http_response",
  websocketOpen: "websocket_open",
  websocketOpened: "websocket_opened",
  websocketOpenError: "websocket_open_error",
  websocketMessage: "websocket_message",
  websocketClose: "websocket_close",
} as const;

export const VELAY_WEBSOCKET_MESSAGE_TYPES = {
  text: "text",
  binary: "binary",
} as const;

export type VelayHeaders = Record<string, string[]>;
export type VelayWebSocketMessageType =
  (typeof VELAY_WEBSOCKET_MESSAGE_TYPES)[keyof typeof VELAY_WEBSOCKET_MESSAGE_TYPES];

export type VelayRegisteredFrame = {
  type: typeof VELAY_FRAME_TYPES.registered;
  assistant_id: string;
  public_url: string;
};

export type VelayHttpRequestFrame = {
  type: typeof VELAY_FRAME_TYPES.httpRequest;
  request_id: string;
  method: string;
  path: string;
  raw_query?: string;
  headers: VelayHeaders;
  body_base64?: string;
};

export type VelayHttpResponseFrame = {
  type: typeof VELAY_FRAME_TYPES.httpResponse;
  request_id: string;
  status_code: number;
  headers?: VelayHeaders;
  body_base64?: string;
};

export type VelayWebSocketOpenFrame = {
  type: typeof VELAY_FRAME_TYPES.websocketOpen;
  connection_id: string;
  path: string;
  raw_query?: string;
  headers: VelayHeaders;
  subprotocol?: string;
};

export type VelayWebSocketOpenedFrame = {
  type: typeof VELAY_FRAME_TYPES.websocketOpened;
  connection_id: string;
};

export type VelayWebSocketOpenErrorFrame = {
  type: typeof VELAY_FRAME_TYPES.websocketOpenError;
  connection_id: string;
  reason?: string;
};

export type VelayWebSocketMessageFrame = {
  type: typeof VELAY_FRAME_TYPES.websocketMessage;
  connection_id: string;
  message_type: VelayWebSocketMessageType;
  body_base64?: string;
};

export type VelayWebSocketCloseFrame = {
  type: typeof VELAY_FRAME_TYPES.websocketClose;
  connection_id: string;
  code?: number;
  reason?: string;
};

export type VelayFrame =
  | VelayRegisteredFrame
  | VelayHttpRequestFrame
  | VelayHttpResponseFrame
  | VelayWebSocketOpenFrame
  | VelayWebSocketOpenedFrame
  | VelayWebSocketOpenErrorFrame
  | VelayWebSocketMessageFrame
  | VelayWebSocketCloseFrame;

export type VelayWebSocketInboundFrame =
  | VelayWebSocketOpenFrame
  | VelayWebSocketMessageFrame
  | VelayWebSocketCloseFrame;

const headersSchema = z.record(z.string(), z.array(z.string()));

const registeredFrameSchema = z.object({
  type: z.literal(VELAY_FRAME_TYPES.registered),
  assistant_id: z.string(),
  public_url: z.string(),
});

const httpRequestFrameSchema = z.object({
  type: z.literal(VELAY_FRAME_TYPES.httpRequest),
  request_id: z.string(),
  method: z.string(),
  path: z.string(),
  raw_query: z.string().optional(),
  headers: headersSchema,
  body_base64: z.string().optional(),
});

const websocketOpenFrameSchema = z.object({
  type: z.literal(VELAY_FRAME_TYPES.websocketOpen),
  connection_id: z.string(),
  path: z.string(),
  raw_query: z.string().optional(),
  headers: headersSchema,
  subprotocol: z.string().optional(),
});

const websocketMessageTypeSchema = z.enum([
  VELAY_WEBSOCKET_MESSAGE_TYPES.text,
  VELAY_WEBSOCKET_MESSAGE_TYPES.binary,
]);

const websocketMessageFrameSchema = z.object({
  type: z.literal(VELAY_FRAME_TYPES.websocketMessage),
  connection_id: z.string(),
  message_type: websocketMessageTypeSchema,
  body_base64: z.string().optional(),
});

const websocketCloseFrameSchema = z.object({
  type: z.literal(VELAY_FRAME_TYPES.websocketClose),
  connection_id: z.string(),
  code: z.number().optional(),
  reason: z.string().optional(),
});

const inboundFrameSchema = z.discriminatedUnion("type", [
  registeredFrameSchema,
  httpRequestFrameSchema,
  websocketOpenFrameSchema,
  websocketMessageFrameSchema,
  websocketCloseFrameSchema,
]);

export function parseVelayFrame(data: unknown): VelayFrame | undefined {
  const raw = decodeWebSocketData(data);
  if (raw === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const result = inboundFrameSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

function decodeWebSocketData(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  return undefined;
}

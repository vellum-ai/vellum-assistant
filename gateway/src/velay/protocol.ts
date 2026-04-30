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
  message_type: keyof typeof VELAY_WEBSOCKET_MESSAGE_TYPES;
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

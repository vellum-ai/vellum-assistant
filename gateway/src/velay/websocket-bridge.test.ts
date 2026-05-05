import { Buffer } from "node:buffer";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  VELAY_FRAME_TYPES,
  VELAY_WEBSOCKET_MESSAGE_TYPES,
  type VelayFrame,
  type VelayWebSocketOpenFrame,
} from "./protocol.js";
import { FakeWebSocket } from "./test-fake-websocket.js";
import { VelayWebSocketBridge } from "./websocket-bridge.js";

const WS_OPEN = WebSocket.OPEN;

const OriginalWebSocket = globalThis.WebSocket;
let fakeSocket: FakeWebSocket;
let sentFrames: VelayFrame[];
let bridge: VelayWebSocketBridge;
let WebSocketMock: ReturnType<typeof mock>;

beforeEach(() => {
  fakeSocket = new FakeWebSocket("", undefined, { validateReason: true });
  sentFrames = [];
  WebSocketMock = mock(() => fakeSocket);
  Object.assign(WebSocketMock, FakeWebSocket);
  globalThis.WebSocket = WebSocketMock as unknown as typeof WebSocket;
  bridge = new VelayWebSocketBridge("http://127.0.0.1:7830", (frame) => {
    sentFrames.push(frame);
  });
});

afterAll(() => {
  globalThis.WebSocket = OriginalWebSocket;
});

function makeOpenFrame(
  overrides: Partial<VelayWebSocketOpenFrame> = {},
): VelayWebSocketOpenFrame {
  return {
    type: VELAY_FRAME_TYPES.websocketOpen,
    connection_id: "conn-123",
    path: "/webhooks/twilio/relay",
    raw_query: "callSessionId=session-123&token=edge-token",
    headers: {},
    ...overrides,
  };
}

function base64(text: string | Uint8Array): string {
  return Buffer.from(text).toString("base64");
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("VelayWebSocketBridge", () => {
  test("opens a loopback WebSocket and sends websocket_opened after local open", () => {
    bridge.handleFrame(
      makeOpenFrame({
        headers: {
          authorization: ["Bearer edge-token"],
          connection: ["upgrade"],
          host: ["public.example.com"],
          "sec-websocket-key": ["client-key"],
          "x-twilio-signature": ["sig-123"],
        },
        subprotocol: "twilio-relay",
      }),
    );

    expect(sentFrames).toEqual([]);
    expect(WebSocketMock).toHaveBeenCalledTimes(1);

    const [url, options] = WebSocketMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; protocols?: string[] },
    ];
    expect(url).toBe(
      "ws://127.0.0.1:7830/webhooks/twilio/relay?callSessionId=session-123&token=edge-token",
    );
    expect(options.protocols).toEqual(["twilio-relay"]);
    expect(options.headers.authorization).toBe("Bearer edge-token");
    expect(options.headers.host).toBe("public.example.com");
    expect(options.headers["x-twilio-signature"]).toBe("sig-123");
    expect(options.headers.connection).toBeUndefined();
    expect(options.headers["sec-websocket-key"]).toBeUndefined();

    fakeSocket.readyState = WS_OPEN;
    fakeSocket.emit("open");

    expect(sentFrames).toEqual([
      {
        type: VELAY_FRAME_TYPES.websocketOpened,
        connection_id: "conn-123",
      },
    ]);
  });

  test("sends websocket_open_error when the local upgrade fails before open", () => {
    bridge.open(makeOpenFrame());

    fakeSocket.emit("error");

    expect(sentFrames).toEqual([
      {
        type: VELAY_FRAME_TYPES.websocketOpenError,
        connection_id: "conn-123",
        reason: "WebSocket connection failed",
      },
    ]);
    expect(bridge.getConnectionCount()).toBe(0);
    expect(fakeSocket.closes).toEqual([{ code: undefined, reason: undefined }]);
  });

  test("forwards text frames from Velay to the local gateway WebSocket", () => {
    bridge.open(makeOpenFrame());
    fakeSocket.readyState = WS_OPEN;
    fakeSocket.emit("open");

    bridge.message({
      type: VELAY_FRAME_TYPES.websocketMessage,
      connection_id: "conn-123",
      message_type: VELAY_WEBSOCKET_MESSAGE_TYPES.text,
      body_base64: base64('{"event":"start"}'),
    });

    expect(fakeSocket.sent).toEqual(['{"event":"start"}']);
  });

  test("preserves leading UTF-8 BOM bytes in Velay text frames", () => {
    bridge.open(makeOpenFrame());
    fakeSocket.readyState = WS_OPEN;
    fakeSocket.emit("open");

    bridge.message({
      type: VELAY_FRAME_TYPES.websocketMessage,
      connection_id: "conn-123",
      message_type: VELAY_WEBSOCKET_MESSAGE_TYPES.text,
      body_base64: base64(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])),
    });

    expect(fakeSocket.sent).toEqual(["\ufeffhi"]);
  });

  test("forwards local text frames back to Velay as websocket_message frames", async () => {
    bridge.open(makeOpenFrame());
    fakeSocket.readyState = WS_OPEN;
    fakeSocket.emit("open");

    fakeSocket.emit("message", { data: "hello from gateway" });
    await flushPromises();

    expect(sentFrames.at(-1)).toEqual({
      type: VELAY_FRAME_TYPES.websocketMessage,
      connection_id: "conn-123",
      message_type: VELAY_WEBSOCKET_MESSAGE_TYPES.text,
      body_base64: base64("hello from gateway"),
    });
  });

  test("preserves binary frames in both directions", async () => {
    bridge.open(makeOpenFrame());
    fakeSocket.readyState = WS_OPEN;
    fakeSocket.emit("open");

    bridge.message({
      type: VELAY_FRAME_TYPES.websocketMessage,
      connection_id: "conn-123",
      message_type: VELAY_WEBSOCKET_MESSAGE_TYPES.binary,
      body_base64: base64(new Uint8Array([1, 2, 3])),
    });

    expect(fakeSocket.sent[0]).toEqual(new Uint8Array([1, 2, 3]));

    fakeSocket.emit("message", { data: new Uint8Array([4, 5, 6]) });
    await flushPromises();

    expect(sentFrames.at(-1)).toEqual({
      type: VELAY_FRAME_TYPES.websocketMessage,
      connection_id: "conn-123",
      message_type: VELAY_WEBSOCKET_MESSAGE_TYPES.binary,
      body_base64: base64(new Uint8Array([4, 5, 6])),
    });
  });

  test("forwards close frames and cleans up the connection map", () => {
    bridge.open(makeOpenFrame());
    fakeSocket.readyState = WS_OPEN;
    fakeSocket.emit("open");

    bridge.close({
      type: VELAY_FRAME_TYPES.websocketClose,
      connection_id: "conn-123",
      code: 1000,
      reason: "done",
    });

    expect(fakeSocket.closes).toEqual([{ code: 1000, reason: "done" }]);
    expect(bridge.getConnectionCount()).toBe(0);

    fakeSocket.emit("close", { code: 1000, reason: "done" });
    expect(
      sentFrames.filter(
        (frame) => frame.type === VELAY_FRAME_TYPES.websocketClose,
      ),
    ).toEqual([]);
  });

  test("remaps protocol close codes from Velay before closing locally", () => {
    bridge.open(makeOpenFrame());
    fakeSocket.readyState = WS_OPEN;
    fakeSocket.emit("open");

    expect(() => {
      bridge.close({
        type: VELAY_FRAME_TYPES.websocketClose,
        connection_id: "conn-123",
        code: 1008,
        reason: "Policy violation",
      });
    }).not.toThrow();

    expect(fakeSocket.closes).toEqual([
      { code: 4008, reason: "Policy violation" },
    ]);
    expect(bridge.getConnectionCount()).toBe(0);
  });

  test("sanitizes invalid reserved close codes from Velay before closing locally", () => {
    bridge.open(makeOpenFrame());
    fakeSocket.readyState = WS_OPEN;
    fakeSocket.emit("open");

    expect(() => {
      bridge.close({
        type: VELAY_FRAME_TYPES.websocketClose,
        connection_id: "conn-123",
        code: 1006,
        reason: "invalid reserved code",
      });
    }).not.toThrow();

    expect(fakeSocket.closes).toEqual([{ code: undefined, reason: undefined }]);
    expect(bridge.getConnectionCount()).toBe(0);
  });

  test("truncates overlong close reasons from Velay without splitting UTF-8 characters", () => {
    bridge.open(makeOpenFrame());
    fakeSocket.readyState = WS_OPEN;
    fakeSocket.emit("open");

    bridge.close({
      type: VELAY_FRAME_TYPES.websocketClose,
      connection_id: "conn-123",
      code: 1000,
      reason: "🙂".repeat(40),
    });

    expect(fakeSocket.closes).toEqual([
      { code: 1000, reason: "🙂".repeat(30) },
    ]);
    expect(
      new TextEncoder().encode(fakeSocket.closes[0].reason).byteLength,
    ).toBe(120);
    expect(bridge.getConnectionCount()).toBe(0);
  });

  test("keeps empty text frames distinct from invalid payloads", () => {
    bridge.open(makeOpenFrame());
    fakeSocket.readyState = WS_OPEN;
    fakeSocket.emit("open");

    bridge.message({
      type: VELAY_FRAME_TYPES.websocketMessage,
      connection_id: "conn-123",
      message_type: VELAY_WEBSOCKET_MESSAGE_TYPES.text,
      body_base64: "",
    });

    expect(fakeSocket.sent).toEqual([""]);
    expect(fakeSocket.closes).toEqual([]);
  });

  test("rejects invalid base64 payloads and cleans up", () => {
    bridge.open(makeOpenFrame());
    fakeSocket.readyState = WS_OPEN;
    fakeSocket.emit("open");

    bridge.message({
      type: VELAY_FRAME_TYPES.websocketMessage,
      connection_id: "conn-123",
      message_type: VELAY_WEBSOCKET_MESSAGE_TYPES.text,
      body_base64: "not base64",
    });

    expect(fakeSocket.closes).toEqual([
      { code: 4003, reason: "Invalid message" },
    ]);
    expect(bridge.getConnectionCount()).toBe(0);
  });

  test("buffers Velay messages until local open", () => {
    bridge.open(makeOpenFrame());

    bridge.message({
      type: VELAY_FRAME_TYPES.websocketMessage,
      connection_id: "conn-123",
      message_type: VELAY_WEBSOCKET_MESSAGE_TYPES.text,
      body_base64: base64("early"),
    });

    expect(fakeSocket.sent).toEqual([]);

    fakeSocket.readyState = WS_OPEN;
    fakeSocket.emit("open");

    expect(fakeSocket.sent).toEqual(["early"]);
  });

  test("sends websocket_open_error without connecting for unsafe paths", () => {
    bridge.open(
      makeOpenFrame({
        path: "https://example.com/webhooks/twilio/relay",
      }),
    );

    expect(WebSocketMock).not.toHaveBeenCalled();
    expect(sentFrames).toEqual([
      {
        type: VELAY_FRAME_TYPES.websocketOpenError,
        connection_id: "conn-123",
        reason: "Invalid WebSocket path",
      },
    ]);
  });

  test("forwards local close frames back to Velay and cleans up", () => {
    bridge.open(makeOpenFrame());
    fakeSocket.readyState = WS_OPEN;
    fakeSocket.emit("open");

    fakeSocket.emit("close", { code: 1001, reason: "going away" });

    expect(bridge.getConnectionCount()).toBe(0);
    expect(sentFrames.at(-1)).toEqual({
      type: VELAY_FRAME_TYPES.websocketClose,
      connection_id: "conn-123",
      code: 1001,
      reason: "going away",
    });
  });

  test("remaps closeAll going-away semantics to an application close code", () => {
    bridge.open(makeOpenFrame());
    fakeSocket.readyState = WS_OPEN;
    fakeSocket.emit("open");

    bridge.closeAll();

    expect(fakeSocket.closes).toEqual([
      { code: 4001, reason: "Tunnel closed" },
    ]);
    expect(bridge.getConnectionCount()).toBe(0);
  });
});

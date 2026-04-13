import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

import { MediaStreamOutput } from "../calls/media-stream-output.js";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

function createMockWs() {
  const sent: string[] = [];
  let closed = false;
  let closeCode: number | undefined;
  let closeReason: string | undefined;

  return {
    ws: {
      send(data: string) {
        if (closed) throw new Error("WebSocket is closed");
        sent.push(data);
      },
      close(code?: number, reason?: string) {
        closed = true;
        closeCode = code;
        closeReason = reason;
      },
    } as unknown as import("bun").ServerWebSocket<unknown>,
    get sent() {
      return sent;
    },
    get closed() {
      return closed;
    },
    get closeCode() {
      return closeCode;
    },
    get closeReason() {
      return closeReason;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MediaStreamOutput", () => {
  describe("CallTransport interface", () => {
    test("sendTextToken is a no-op", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendTextToken("hello", false);
      output.sendTextToken("world", true);
      expect(sent).toHaveLength(0);
    });

    test("sendPlayUrl is a no-op", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      output.sendPlayUrl("https://example.com/audio.mp3");
      expect(sent).toHaveLength(0);
    });

    test("endSession closes the WebSocket with code 1000", () => {
      const mock = createMockWs();
      const output = new MediaStreamOutput(mock.ws, "stream-1");
      output.endSession("test-reason");
      expect(mock.closed).toBe(true);
      expect(mock.closeCode).toBe(1000);
      expect(mock.closeReason).toBe("test-reason");
    });

    test("endSession uses default reason when none provided", () => {
      const mock = createMockWs();
      const output = new MediaStreamOutput(mock.ws, "stream-1");
      output.endSession();
      expect(mock.closed).toBe(true);
      expect(mock.closeReason).toBe("session-ended");
    });

    test("endSession is idempotent", () => {
      const mock = createMockWs();
      const output = new MediaStreamOutput(mock.ws, "stream-1");
      output.endSession("first");
      // Second call should not throw (ws.close would throw on already-closed)
      output.endSession("second");
      expect(mock.closed).toBe(true);
    });

    test("getConnectionState returns 'connected' initially", () => {
      const { ws } = createMockWs();
      const output = new MediaStreamOutput(ws, "stream-1");
      expect(output.getConnectionState()).toBe("connected");
    });

    test("getConnectionState returns 'closed' after endSession", () => {
      const mock = createMockWs();
      const output = new MediaStreamOutput(mock.ws, "stream-1");
      output.endSession();
      expect(output.getConnectionState()).toBe("closed");
    });
  });

  describe("sendAudioPayload", () => {
    test("sends a media command with the base64 payload", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "MZ-stream-1");
      output.sendAudioPayload("dGVzdA==");

      expect(sent).toHaveLength(1);
      const parsed = JSON.parse(sent[0]);
      expect(parsed).toEqual({
        event: "media",
        streamSid: "MZ-stream-1",
        media: { payload: "dGVzdA==" },
      });
    });

    test("does not send when closed", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "MZ-stream-1");
      output.endSession();
      output.sendAudioPayload("dGVzdA==");
      // Only the close would have happened, no media sent
      expect(sent).toHaveLength(0);
    });
  });

  describe("sendMark", () => {
    test("sends a mark command with the given name", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "MZ-stream-1");
      output.sendMark("end-of-turn");

      expect(sent).toHaveLength(1);
      const parsed = JSON.parse(sent[0]);
      expect(parsed).toEqual({
        event: "mark",
        streamSid: "MZ-stream-1",
        mark: { name: "end-of-turn" },
      });
    });

    test("does not send when closed", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "MZ-stream-1");
      output.endSession();
      output.sendMark("end-of-turn");
      expect(sent).toHaveLength(0);
    });
  });

  describe("clearAudio", () => {
    test("sends a clear command", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "MZ-stream-1");
      output.clearAudio();

      expect(sent).toHaveLength(1);
      const parsed = JSON.parse(sent[0]);
      expect(parsed).toEqual({
        event: "clear",
        streamSid: "MZ-stream-1",
      });
    });

    test("does not send when closed", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "MZ-stream-1");
      output.endSession();
      output.clearAudio();
      expect(sent).toHaveLength(0);
    });
  });

  describe("setStreamSid / getStreamSid", () => {
    test("updates the stream SID used in subsequent commands", () => {
      const { ws, sent } = createMockWs();
      const output = new MediaStreamOutput(ws, "old-sid");
      expect(output.getStreamSid()).toBe("old-sid");

      output.setStreamSid("new-sid");
      expect(output.getStreamSid()).toBe("new-sid");

      output.sendAudioPayload("dGVzdA==");
      const parsed = JSON.parse(sent[0]);
      expect(parsed.streamSid).toBe("new-sid");
    });
  });

  describe("markClosed", () => {
    test("transitions to closed state without sending a close frame", () => {
      const mock = createMockWs();
      const output = new MediaStreamOutput(mock.ws, "stream-1");
      output.markClosed();
      expect(output.getConnectionState()).toBe("closed");
      expect(mock.closed).toBe(false); // WebSocket not actually closed
      output.sendAudioPayload("dGVzdA=="); // Should be suppressed
      expect(mock.sent).toHaveLength(0);
    });
  });

  describe("error resilience", () => {
    test("sendAudioPayload handles ws.send throwing", () => {
      const ws = {
        send() {
          throw new Error("send failed");
        },
        close() {},
      } as unknown as import("bun").ServerWebSocket<unknown>;

      const output = new MediaStreamOutput(ws, "stream-1");
      // Should not throw
      expect(() => output.sendAudioPayload("dGVzdA==")).not.toThrow();
    });

    test("endSession handles ws.close throwing", () => {
      const ws = {
        send() {},
        close() {
          throw new Error("close failed");
        },
      } as unknown as import("bun").ServerWebSocket<unknown>;

      const output = new MediaStreamOutput(ws, "stream-1");
      // Should not throw
      expect(() => output.endSession()).not.toThrow();
    });
  });
});

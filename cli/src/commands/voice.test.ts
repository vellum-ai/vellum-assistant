import { describe, expect, test } from "bun:test";

import { CliLiveVoiceClient } from "../lib/live-voice/client.js";

import { runSession } from "./voice.js";

/**
 * Minimal stand-in for the WebSocket the client drives, matching the fake in
 * `lib/live-voice/client.test.ts`. `runSession` is exercised through a real
 * `CliLiveVoiceClient` rather than a hand-rolled fake client, because the
 * client has private fields and cannot be satisfied structurally.
 */
class FakeSocket {
  static readonly OPEN = 1;
  binaryType = "arraybuffer";
  readyState = 0;
  readonly sent: string[] = [];
  closed = false;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const READY = {
  type: "ready",
  seq: 1,
  sessionId: "sess_1",
  conversationId: "conv_1",
  textInput: true,
};

describe("runSession --say", () => {
  test("ends the session after turnDone even with no player (--no-audio)", async () => {
    const socket = new FakeSocket();
    const client = new CliLiveVoiceClient({
      url: "ws://127.0.0.1:7830/v1/live-voice",
      token: "guardian-token",
      webSocketFactory: () => socket as unknown as WebSocket,
    });

    // player: null is what `--no-audio` passes. Before the fix, `turnDone`'s
    // `player?.finish().then(...)` short-circuited entirely on a null player,
    // so `endTurn()` (and therefore `client.end()`) never ran and the session
    // hung forever with the socket still open. This test hangs on that
    // regression rather than failing fast, which is exactly the bug: the
    // suite's own timeout is what would catch it.
    const sessionDone = runSession({
      client,
      player: null,
      reference: "test-assistant (asst_1)",
      sayText: "hello",
    });

    socket.open();
    socket.deliver(READY);
    socket.deliver({ type: "tts_done", seq: 2, turnId: "turn_1" });

    await sessionDone;

    expect(socket.closed).toBe(true);
  });
});

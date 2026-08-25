import { describe, expect, test } from "bun:test";

import { CliLiveVoiceClient } from "./client.js";
import { MAX_TEXT_TURN_CHARS } from "./protocol.js";

/**
 * Minimal stand-in for the WebSocket the client drives. Records what went out
 * and lets a test push server frames in, so the version-skew rules can be
 * exercised without a daemon.
 */
class FakeSocket {
  static readonly OPEN = 1;
  binaryType = "arraybuffer";
  readyState = 0;
  readonly sent: string[] = [];
  readonly binarySent: Buffer[] = [];
  closed = false;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  send(data: string | Buffer): void {
    if (typeof data === "string") {
      this.sent.push(data);
      return;
    }
    this.binarySent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  /** Complete the handshake and let the client send its `start` frame. */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  /** Deliver one server frame. */
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  sentFrames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

function connected(): { client: CliLiveVoiceClient; socket: FakeSocket } {
  const socket = new FakeSocket();
  const client = new CliLiveVoiceClient({
    url: "ws://127.0.0.1:7830/v1/live-voice",
    token: "guardian-token",
    webSocketFactory: () => socket as unknown as WebSocket,
  });
  client.connect();
  socket.open();
  return { client, socket };
}

const READY = {
  type: "ready",
  seq: 1,
  sessionId: "sess_1",
  conversationId: "conv_1",
  textInput: true,
};

describe("start frame", () => {
  test("declares textInput so a missing STT leg degrades instead of failing", () => {
    const { socket } = connected();
    const start = socket.sentFrames()[0]!;

    expect(start.type).toBe("start");
    // Load-bearing: without it the daemon refuses a session whose speech-to-text
    // credential is missing, which is the case this client exists to survive.
    expect(start.textInput).toBe(true);
    expect(start.audio).toEqual({
      mimeType: "audio/pcm",
      sampleRate: 16000,
      channels: 1,
    });
  });

  test("carries a conversation id only when one was given", () => {
    const socket = new FakeSocket();
    const client = new CliLiveVoiceClient({
      url: "ws://127.0.0.1:7830/v1/live-voice",
      token: "guardian-token",
      conversationId: "conv_resume",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    client.connect();
    socket.open();

    expect(socket.sentFrames()[0]!.conversationId).toBe("conv_resume");
    expect(connected().socket.sentFrames()[0]!).not.toHaveProperty(
      "conversationId",
    );
  });
});

describe("typed turns", () => {
  test("are refused until a ready frame echoes textInput", () => {
    const { client, socket } = connected();

    // Pre-ready: the session is not active yet.
    expect(client.sendText("hello")).toBe(false);

    socket.deliver(READY);
    expect(client.supportsTextInput).toBe(true);
    expect(client.sendText("hello")).toBe(true);
    expect(socket.sentFrames().at(-1)).toEqual({ type: "text", text: "hello" });
  });

  test("are refused when ready omits textInput, rather than sent blind", () => {
    const { client, socket } = connected();
    // A daemon predating typed turns answers `text` with `unknown_type`, which
    // is byte-identical to the `update_config` rejection, so absence of the
    // echo has to mean "no", not "probably fine".
    socket.deliver({ ...READY, textInput: undefined });

    expect(client.supportsTextInput).toBe(false);
    expect(client.sendText("hello")).toBe(false);
    expect(socket.sentFrames().some((f) => f.type === "text")).toBe(false);
  });

  test("are trimmed, and empty or over-long text never reaches the socket", () => {
    const { client, socket } = connected();
    socket.deliver(READY);

    expect(client.sendText("   ")).toBe(false);
    expect(client.sendText("x".repeat(MAX_TEXT_TURN_CHARS + 1))).toBe(false);
    expect(client.sendText("  spaced  ")).toBe(true);
    expect(socket.sentFrames().at(-1)).toEqual({
      type: "text",
      text: "spaced",
    });
  });
});

describe("ready echoes", () => {
  test("audioInput false opens a text-only session rather than failing it", () => {
    const { client, socket } = connected();
    let closedWith: string | undefined | "never" = "never";
    client.on("closed", (error) => {
      closedWith = error;
    });

    socket.deliver({ ...READY, audioInput: false });

    expect(client.hasAudioInput).toBe(false);
    expect(client.supportsTextInput).toBe(true);
    expect(closedWith).toBe("never");
  });

  test("absent audioInput means the STT leg is live", () => {
    const { client, socket } = connected();
    socket.deliver(READY);
    expect(client.hasAudioInput).toBe(true);
  });
});

describe("error frames", () => {
  test("a text-attributed rejection is reported, not treated as fatal", () => {
    const { client, socket } = connected();
    socket.deliver(READY);

    const rejections: [string, string][] = [];
    let closed = false;
    client.on("textTurnRejected", (reason, message) =>
      rejections.push([reason, message]),
    );
    client.on("closed", () => {
      closed = true;
    });

    socket.deliver({
      type: "error",
      seq: 2,
      code: "turn_in_progress",
      message: "already replying",
      recoverable: true,
      frameType: "text",
    });

    expect(rejections).toEqual([["busy", "already replying"]]);
    expect(closed).toBe(false);
  });

  test("unknown_type about a text frame reads as unsupported, not busy", () => {
    const { client, socket } = connected();
    socket.deliver(READY);

    const rejections: [string, string][] = [];
    client.on("textTurnRejected", (reason, message) =>
      rejections.push([reason, message]),
    );

    socket.deliver({
      type: "error",
      seq: 2,
      code: "unknown_type",
      message: "unknown frame type",
      frameType: "text",
    });

    expect(rejections[0]![0]).toBe("unsupported");
  });

  test("a recoverable error unrelated to a typed turn is a warning", () => {
    const { client, socket } = connected();
    socket.deliver(READY);

    const warnings: string[] = [];
    let closed = false;
    client.on("warning", (message) => warnings.push(message));
    client.on("closed", () => {
      closed = true;
    });

    socket.deliver({
      type: "error",
      seq: 2,
      code: "tts_failed",
      message: "voice blip",
      recoverable: true,
    });

    expect(warnings).toEqual(["voice blip"]);
    expect(closed).toBe(false);
  });

  test("a non-recoverable error ends the session", () => {
    const { client, socket } = connected();
    socket.deliver(READY);

    let closedWith: string | undefined;
    client.on("closed", (error) => {
      closedWith = error;
    });

    socket.deliver({
      type: "error",
      seq: 2,
      code: "credentials_unavailable",
      message: "no tts credential",
    });

    expect(closedWith).toBe("no tts credential");
    expect(socket.closed).toBe(true);
  });
});

describe("session lifecycle", () => {
  test("busy ends the session naming the session already holding the floor", () => {
    const { client, socket } = connected();
    let closedWith: string | undefined;
    client.on("closed", (error) => {
      closedWith = error;
    });

    socket.deliver({ type: "busy", seq: 1, activeSessionId: "sess_other" });

    expect(closedWith).toContain("sess_other");
  });

  test("a close before ready explains the likely credential rejection", () => {
    const { client, socket } = connected();
    let closedWith: string | undefined;
    client.on("closed", (error) => {
      closedWith = error;
    });

    socket.onclose?.({ code: 1008, reason: "" });

    expect(closedWith).toContain("1008");
    expect(closedWith).toContain("credential");
  });

  test("end sends the end frame once and is idempotent", () => {
    const { client, socket } = connected();
    socket.deliver(READY);

    client.end();
    client.end();

    expect(socket.sentFrames().filter((f) => f.type === "end")).toHaveLength(1);
    expect(socket.closed).toBe(true);
  });

  test("frames from a newer daemon are ignored, not fatal", () => {
    const { client, socket } = connected();
    socket.deliver(READY);
    let closed = false;
    client.on("closed", () => {
      closed = true;
    });

    socket.deliver({ type: "some_future_frame", seq: 2 });
    socket.onmessage?.({ data: "not json at all" });

    expect(closed).toBe(false);
    expect(client.sendText("still working")).toBe(true);
  });
});

describe("interrupt", () => {
  test("goes out only while a session is active", () => {
    const { client, socket } = connected();
    client.interrupt();
    expect(socket.sentFrames().some((f) => f.type === "interrupt")).toBe(false);

    socket.deliver(READY);
    client.interrupt();
    expect(socket.sentFrames().at(-1)).toEqual({ type: "interrupt" });
  });
});

describe("listening sessions", () => {
  const listening = (): { client: CliLiveVoiceClient; socket: FakeSocket } => {
    const socket = new FakeSocket();
    const client = new CliLiveVoiceClient({
      url: "ws://127.0.0.1:7830/v1/live-voice",
      token: "guardian-token",
      turnDetection: "server_vad",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    client.connect();
    socket.open();
    return { client, socket };
  };

  test("asks for server_vad only when a microphone is open", () => {
    expect(listening().socket.sentFrames()[0]!.turnDetection).toBe(
      "server_vad",
    );
    // A session with no recorder must not ask: the daemon would wait on
    // utterance boundaries in a stream that carries no audio.
    expect(connected().socket.sentFrames()[0]!).not.toHaveProperty(
      "turnDetection",
    );
  });

  test("reports the mode the daemon actually ran, not the one requested", () => {
    const { client, socket } = listening();
    // A daemon that ignored the request runs manual, and this client sends no
    // ptt_release, so a spoken turn there would never close.
    socket.deliver({ ...READY, turnDetection: undefined });
    expect(client.turnDetection).toBe("manual");

    const second = listening();
    second.socket.deliver({ ...READY, turnDetection: "server_vad" });
    expect(second.client.turnDetection).toBe("server_vad");
  });

  test("audio goes out as binary, and only once the session is listening", () => {
    const { client, socket } = listening();
    const pcm = Buffer.alloc(320);

    client.sendAudio(pcm);
    expect(socket.binarySent).toHaveLength(0);

    socket.deliver({ ...READY, turnDetection: "server_vad" });
    client.sendAudio(pcm);
    expect(socket.binarySent).toHaveLength(1);
    // Base64 would inflate every chunk by a third on a continuous stream.
    expect(socket.sent.some((raw) => raw.includes("dataBase64"))).toBe(false);
  });

  test("audio is dropped when the speech-to-text leg never came up", () => {
    const { client, socket } = listening();
    socket.deliver({
      ...READY,
      turnDetection: "server_vad",
      audioInput: false,
    });

    client.sendAudio(Buffer.alloc(320));

    expect(client.hasAudioInput).toBe(false);
    expect(socket.binarySent).toHaveLength(0);
  });

  test("capture frames reach their listeners", () => {
    const { client, socket } = listening();
    socket.deliver({ ...READY, turnDetection: "server_vad" });

    const seen: string[] = [];
    client.on("speechStarted", () => seen.push("start"));
    client.on("sttPartial", (f) => seen.push(`partial:${f.text}`));
    client.on("sttFinal", (f) => seen.push(`final:${f.text}`));
    client.on("utteranceEnd", () => seen.push("end"));
    client.on("utteranceDiscarded", () => seen.push("discarded"));

    socket.deliver({ type: "speech_started", seq: 2 });
    socket.deliver({ type: "stt_partial", seq: 3, text: "hel" });
    socket.deliver({ type: "stt_final", seq: 4, text: "hello" });
    socket.deliver({ type: "utterance_end", seq: 5 });
    socket.deliver({ type: "utterance_discarded", seq: 6 });

    expect(seen).toEqual([
      "start",
      "partial:hel",
      "final:hello",
      "end",
      "discarded",
    ]);
  });
});

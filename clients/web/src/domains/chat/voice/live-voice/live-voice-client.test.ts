/**
 * Tests for the browser live-voice WebSocket client.
 *
 * `mintLiveVoiceToken` is mocked at module scope so no real HTTP/SDK call
 * happens; `buildLiveVoiceWsUrl` is kept real so we exercise the genuine
 * connection.ts URL builder (no hardcoded host in the client). The WebSocket is
 * a hand-rolled fake injected via the client's `webSocketFactory` option — no
 * global patching needed.
 *
 * Coverage: start-frame on open, every server frame -> typed event, binary
 * audio passthrough, connect timeout when no `ready`, `busy` handling, mint
 * failure, and clean `end()` / `close()` teardown.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

let mintResult: Promise<{ token: string; expiresAt: string }> = Promise.resolve(
  { token: "tok-abc", expiresAt: "2026-06-01T00:05:00Z" },
);

// The client resolves its transport URL via `resolveLiveVoiceWsUrl`. Mock it to
// the cloud (velay) path: await `mintResult` (so the mint-failure test still
// exercises a rejected resolve) and compose the genuine velay URL the client
// would dial. The connection.ts routing/builders are unit-tested separately in
// connection.test.ts.
mock.module("@/domains/chat/voice/live-voice/connection", () => ({
  resolveLiveVoiceWsUrl: mock(
    async ({
      assistantId,
      conversationId,
    }: {
      assistantId: string;
      conversationId?: string;
    }) => {
      const { token } = await mintResult;
      const url = new URL(`wss://velay.vellum.ai/${assistantId}/v1/live-voice`);
      url.searchParams.set("token", token);
      if (conversationId) url.searchParams.set("conversationId", conversationId);
      return url.toString();
    },
  ),
}));

import type { LiveVoiceChannelClient as LiveVoiceChannelClientType } from "@/domains/chat/voice/live-voice/live-voice-client";

// Import the module under test *after* registering the connection mock, so the
// mock is in place before the real connection.ts (which imports the generated
// SDK client) would otherwise be pulled into the static import graph.
const { LiveVoiceChannelClient } = await import(
  "@/domains/chat/voice/live-voice/live-voice-client"
);

// ---------------------------------------------------------------------------
// Fake WebSocket
// ---------------------------------------------------------------------------

type SentMessage = string | ArrayBuffer;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  // Mirror the WHATWG readyState constants the client guards on.
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  binaryType = "blob";
  sent: SentMessage[] = [];
  closed = false;
  // Sockets start life CONNECTING, exactly like a real WebSocket.
  readyState = FakeWebSocket.CONNECTING;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: SentMessage): void {
    // Match browser behaviour: sending on a non-OPEN socket throws.
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("InvalidStateError: WebSocket is not open");
    }
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  // --- test drivers ---
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  receive(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  receiveRaw(data: unknown): void {
    this.onmessage?.({ data });
  }
  emitError(): void {
    this.onerror?.();
  }
  emitClose(): void {
    this.onclose?.();
  }

  get sentText(): string[] {
    return this.sent.filter((m): m is string => typeof m === "string");
  }
  get sentJson(): Record<string, unknown>[] {
    return this.sentText.map((t) => JSON.parse(t));
  }
  get sentBinary(): ArrayBuffer[] {
    return this.sent.filter((m): m is ArrayBuffer => m instanceof ArrayBuffer);
  }
}

function makeClient(connectTimeoutMs = 10_000) {
  const factory = (url: string) => new FakeWebSocket(url) as unknown as WebSocket;
  const client = new LiveVoiceChannelClient({
    webSocketFactory: factory,
    connectTimeoutMs,
  });
  return client;
}

/** Connect and return the underlying fake socket once constructed. */
async function connectAndGetSocket(
  client: LiveVoiceChannelClientType,
  args: { assistantId: string; conversationId?: string } = {
    assistantId: "assistant-1",
  },
): Promise<FakeWebSocket> {
  await client.connect(args);
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error("no WebSocket was constructed");
  return ws;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  mintResult = Promise.resolve({
    token: "tok-abc",
    expiresAt: "2026-06-01T00:05:00Z",
  });
});

afterEach(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// connect + start frame
// ---------------------------------------------------------------------------

describe("connect", () => {
  test("mints a token and opens the velay WS at the built URL", async () => {
    const ws = await connectAndGetSocket(makeClient(), {
      assistantId: "assistant-1",
      conversationId: "conv-xyz",
    });
    const url = new URL(ws.url);
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("velay.vellum.ai");
    expect(url.pathname).toBe("/assistant-1/v1/live-voice");
    expect(url.searchParams.get("token")).toBe("tok-abc");
    expect(url.searchParams.get("conversationId")).toBe("conv-xyz");
  });

  test("requests arraybuffer binary frames", async () => {
    const ws = await connectAndGetSocket(makeClient());
    expect(ws.binaryType).toBe("arraybuffer");
  });

  test("sends the start frame as JSON text on open, with conversationId", async () => {
    const ws = await connectAndGetSocket(makeClient(), {
      assistantId: "assistant-1",
      conversationId: "conv-xyz",
    });
    ws.open();

    expect(ws.sentJson).toEqual([
      {
        type: "start",
        audio: { mimeType: "audio/pcm", sampleRate: 16000, channels: 1 },
        conversationId: "conv-xyz",
      },
    ]);
    expect(ws.sentBinary).toHaveLength(0);
  });

  test("omits conversationId from the start frame when not provided", async () => {
    const ws = await connectAndGetSocket(makeClient());
    ws.open();
    expect(ws.sentJson[0]).toEqual({
      type: "start",
      audio: { mimeType: "audio/pcm", sampleRate: 16000, channels: 1 },
    });
  });

  test("emits error when token minting fails", async () => {
    mintResult = Promise.reject(new Error("mint boom"));
    const client = makeClient();
    const errors: { reason: string; message: string }[] = [];
    client.on("error", (e) => errors.push(e));

    await client.connect({ assistantId: "assistant-1" });

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toBe("connection-failed");
  });
});

// ---------------------------------------------------------------------------
// server frame dispatch
// ---------------------------------------------------------------------------

describe("server frame dispatch", () => {
  async function ready(): Promise<{
    client: LiveVoiceChannelClientType;
    ws: FakeWebSocket;
  }> {
    const client = makeClient();
    const ws = await connectAndGetSocket(client);
    ws.open();
    ws.receive({ type: "ready", seq: 1, sessionId: "s1", conversationId: "c1" });
    return { client, ws };
  }

  test("ready transitions to active and dispatches the ready event", async () => {
    const client = makeClient();
    const ws = await connectAndGetSocket(client);
    ws.open();

    const seen: unknown[] = [];
    client.on("ready", (f) => seen.push(f));
    ws.receive({
      type: "ready",
      seq: 1,
      sessionId: "sess-1",
      conversationId: "conv-1",
    });

    expect(seen).toEqual([
      { type: "ready", seq: 1, sessionId: "sess-1", conversationId: "conv-1" },
    ]);
  });

  test("dispatches each transcript/text/tts/metrics/archived frame to its event", async () => {
    const { client, ws } = await ready();

    const got: Record<string, unknown[]> = {};
    const record = (name: string) => (f: unknown) => {
      (got[name] ??= []).push(f);
    };
    client.on("sttPartial", record("sttPartial"));
    client.on("sttFinal", record("sttFinal"));
    client.on("thinking", record("thinking"));
    client.on("assistantTextDelta", record("assistantTextDelta"));
    client.on("ttsAudio", record("ttsAudio"));
    client.on("ttsDone", record("ttsDone"));
    client.on("metrics", record("metrics"));
    client.on("archived", record("archived"));

    ws.receive({ type: "stt_partial", seq: 2, text: "hel" });
    ws.receive({ type: "stt_final", seq: 3, text: "hello" });
    ws.receive({ type: "thinking", seq: 4, turnId: "t1" });
    ws.receive({ type: "assistant_text_delta", seq: 5, text: "hi" });
    ws.receive({
      type: "tts_audio",
      seq: 6,
      mimeType: "audio/pcm",
      sampleRate: 24000,
      dataBase64: "AAAA",
    });
    ws.receive({ type: "tts_done", seq: 7, turnId: "t1" });
    ws.receive({
      type: "metrics",
      seq: 8,
      turnId: "t1",
      sttMs: 1,
      llmFirstDeltaMs: 2,
      ttsFirstAudioMs: 3,
      totalMs: 4,
    });
    ws.receive({
      type: "archived",
      seq: 9,
      conversationId: "c1",
      sessionId: "s1",
    });

    expect(got.sttPartial).toEqual([{ type: "stt_partial", seq: 2, text: "hel" }]);
    expect(got.sttFinal).toEqual([{ type: "stt_final", seq: 3, text: "hello" }]);
    expect(got.thinking).toEqual([{ type: "thinking", seq: 4, turnId: "t1" }]);
    expect(got.assistantTextDelta).toEqual([
      { type: "assistant_text_delta", seq: 5, text: "hi" },
    ]);
    expect(got.ttsAudio).toHaveLength(1);
    expect(got.ttsDone).toEqual([{ type: "tts_done", seq: 7, turnId: "t1" }]);
    expect(got.metrics).toHaveLength(1);
    expect(got.archived).toHaveLength(1);
  });

  test("server error frame emits a protocol-error and closes", async () => {
    const { client, ws } = await ready();
    const errors: { reason: string; code?: string; message: string }[] = [];
    let closedCount = 0;
    client.on("error", (e) => errors.push(e));
    client.on("closed", () => closedCount++);

    ws.receive({ type: "error", seq: 10, code: "boom", message: "kaboom" });

    expect(errors).toEqual([
      { reason: "protocol-error", code: "boom", message: "kaboom" },
    ]);
    expect(closedCount).toBe(1);
    expect(ws.closed).toBe(true);
  });

  test("ignores inbound binary frames (no parse, no event)", async () => {
    const { client, ws } = await ready();
    const errors: unknown[] = [];
    client.on("error", (e) => errors.push(e));

    ws.receiveRaw(new ArrayBuffer(8));

    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// busy handling (distinct from error)
// ---------------------------------------------------------------------------

describe("busy", () => {
  test("emits busy (not error) and closes the socket", async () => {
    const client = makeClient();
    const ws = await connectAndGetSocket(client);
    ws.open();

    const busy: unknown[] = [];
    const errors: unknown[] = [];
    let closedCount = 0;
    client.on("busy", (f) => busy.push(f));
    client.on("error", (e) => errors.push(e));
    client.on("closed", () => closedCount++);

    ws.receive({ type: "busy", seq: 1, activeSessionId: "other-sess" });

    expect(busy).toEqual([
      { type: "busy", seq: 1, activeSessionId: "other-sess" },
    ]);
    expect(errors).toHaveLength(0);
    expect(closedCount).toBe(1);
    expect(ws.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// audio passthrough
// ---------------------------------------------------------------------------

describe("sendAudio", () => {
  test("sends PCM as a binary frame once active", async () => {
    const client = makeClient();
    const ws = await connectAndGetSocket(client);
    ws.open();
    ws.receive({ type: "ready", seq: 1, sessionId: "s", conversationId: "c" });

    const pcm = new Int16Array([1, 2, 3]).buffer;
    client.sendAudio(pcm);

    expect(ws.sentBinary).toEqual([pcm]);
    // The only text frame should be the start frame.
    expect(ws.sentJson).toEqual([
      {
        type: "start",
        audio: { mimeType: "audio/pcm", sampleRate: 16000, channels: 1 },
      },
    ]);
  });

  test("drops audio before ready (session not active)", async () => {
    const client = makeClient();
    const ws = await connectAndGetSocket(client);
    ws.open();

    client.sendAudio(new ArrayBuffer(4));
    expect(ws.sentBinary).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// control frames
// ---------------------------------------------------------------------------

describe("control frames", () => {
  test("pttRelease and interrupt go out as JSON text when active", async () => {
    const client = makeClient();
    const ws = await connectAndGetSocket(client);
    ws.open();
    ws.receive({ type: "ready", seq: 1, sessionId: "s", conversationId: "c" });

    client.pttRelease();
    client.interrupt();

    expect(ws.sentJson.slice(1)).toEqual([
      { type: "ptt_release" },
      { type: "interrupt" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// connect timeout
// ---------------------------------------------------------------------------

describe("connect timeout", () => {
  test("fails with timeout when no ready arrives within the window", async () => {
    const client = makeClient(20);
    const ws = await connectAndGetSocket(client);
    ws.open();

    const errors: { reason: string }[] = [];
    let closedCount = 0;
    client.on("error", (e) => errors.push(e));
    client.on("closed", () => closedCount++);

    await new Promise((r) => setTimeout(r, 40));

    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toBe("timeout");
    expect(closedCount).toBe(1);
    expect(ws.closed).toBe(true);
  });

  test("does not fire timeout once ready arrives", async () => {
    const client = makeClient(20);
    const ws = await connectAndGetSocket(client);
    ws.open();
    ws.receive({ type: "ready", seq: 1, sessionId: "s", conversationId: "c" });

    const errors: unknown[] = [];
    client.on("error", (e) => errors.push(e));

    await new Promise((r) => setTimeout(r, 40));

    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------

describe("teardown", () => {
  test("end() sends an end frame then closes the socket", async () => {
    const client = makeClient();
    const ws = await connectAndGetSocket(client);
    ws.open();
    ws.receive({ type: "ready", seq: 1, sessionId: "s", conversationId: "c" });

    let closedCount = 0;
    client.on("closed", () => closedCount++);

    client.end();

    expect(ws.sentJson.at(-1)).toEqual({ type: "end" });
    expect(ws.closed).toBe(true);
    expect(closedCount).toBe(1);
  });

  test("end() during connect (socket still CONNECTING) cancels cleanly without throwing", async () => {
    const client = makeClient();
    // Construct the socket but never open() it -> it stays CONNECTING.
    const ws = await connectAndGetSocket(client);
    expect(ws.readyState).toBe(FakeWebSocket.CONNECTING);

    const errors: { reason: string }[] = [];
    let closedCount = 0;
    client.on("error", (e) => errors.push(e));
    client.on("closed", () => closedCount++);

    // Must not throw even though the socket can't accept sends yet.
    expect(() => client.end()).not.toThrow();

    // No `end` frame could be sent on a CONNECTING socket.
    expect(ws.sent).toHaveLength(0);
    // The socket is closed and the session ended cleanly — no timeout/failure.
    expect(ws.closed).toBe(true);
    expect(closedCount).toBe(1);
    expect(errors).toHaveLength(0);
  });

  test("close() during connect (socket still CONNECTING) closes cleanly without throwing", async () => {
    const client = makeClient();
    const ws = await connectAndGetSocket(client);
    expect(ws.readyState).toBe(FakeWebSocket.CONNECTING);

    const errors: unknown[] = [];
    let closedCount = 0;
    client.on("error", (e) => errors.push(e));
    client.on("closed", () => closedCount++);

    expect(() => client.close()).not.toThrow();

    expect(ws.closed).toBe(true);
    expect(closedCount).toBe(1);
    expect(errors).toHaveLength(0);
  });

  test("close() is idempotent and emits closed exactly once", async () => {
    const client = makeClient();
    const ws = await connectAndGetSocket(client);
    ws.open();

    let closedCount = 0;
    client.on("closed", () => closedCount++);

    client.close();
    client.close();

    expect(closedCount).toBe(1);
    expect(ws.closed).toBe(true);
  });

  test("after close, sendAudio and control frames are no-ops", async () => {
    const client = makeClient();
    const ws = await connectAndGetSocket(client);
    ws.open();
    ws.receive({ type: "ready", seq: 1, sessionId: "s", conversationId: "c" });
    const before = ws.sent.length;

    client.close();
    client.sendAudio(new ArrayBuffer(4));
    client.pttRelease();
    client.interrupt();

    expect(ws.sent.length).toBe(before);
  });

  test("an unexpected socket close before ready surfaces a connection failure", async () => {
    const client = makeClient();
    const ws = await connectAndGetSocket(client);
    ws.open();

    const errors: { reason: string }[] = [];
    client.on("error", (e) => errors.push(e));

    ws.emitClose();

    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toBe("connection-failed");
  });
});

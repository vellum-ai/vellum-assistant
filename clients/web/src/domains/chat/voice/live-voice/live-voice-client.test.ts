/**
 * Tests for the browser live-voice WebSocket client.
 *
 * `mintVelayWsToken` is mocked at module scope so no real HTTP/SDK call
 * happens; `buildLiveVoiceWsUrl` is kept real so we exercise the genuine
 * connection.ts URL builder (no hardcoded host in the client). The WebSocket is
 * a hand-rolled fake injected via the client's `webSocketFactory` option — no
 * global patching needed.
 *
 * Coverage: start-frame on open, every server frame -> typed event, binary
 * audio passthrough, connect timeout when no `ready`, `busy` handling, mint
 * failure, and clean `end()` / `close()` teardown.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

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
      if (conversationId) {
        url.searchParams.set("conversationId", conversationId);
      }
      return url.toString();
    },
  ),
}));

import type { LiveVoiceChannelClient as LiveVoiceChannelClientType } from "@/domains/chat/voice/live-voice/live-voice-client";

// Import the module under test *after* registering the connection mock, so the
// mock is in place before the real connection.ts (which imports the generated
// SDK client) would otherwise be pulled into the static import graph.
const { LiveVoiceChannelClient } =
  await import("@/domains/chat/voice/live-voice/live-voice-client");

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
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

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
  emitClose(code = 1000, reason = ""): void {
    this.onclose?.({ code, reason });
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
  const factory = (url: string) =>
    new FakeWebSocket(url) as unknown as WebSocket;
  const client = new LiveVoiceChannelClient({
    webSocketFactory: factory,
    connectTimeoutMs,
  });
  return client;
}

/** Connect and return the underlying fake socket once constructed. */
async function connectAndGetSocket(
  client: LiveVoiceChannelClientType,
  args: {
    assistantId: string;
    conversationId?: string;
    turnDetection?: "manual" | "server_vad";
    silenceThresholdMs?: number;
    bargeInMinSpeechMs?: number;
  } = { assistantId: "assistant-1" },
): Promise<FakeWebSocket> {
  await client.connect(args);
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) {
    throw new Error("no WebSocket was constructed");
  }
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
        client: "web",
        textInput: true,
        audio: { mimeType: "audio/pcm", sampleRate: 16000, channels: 1 },
        conversationId: "conv-xyz",
      },
    ]);
    expect(ws.sentBinary).toHaveLength(0);
  });

  test("omits conversationId and turnDetection from the start frame when not provided", async () => {
    const ws = await connectAndGetSocket(makeClient());
    ws.open();
    expect(ws.sentJson[0]).toEqual({
      type: "start",
      client: "web",
      textInput: true,
      audio: { mimeType: "audio/pcm", sampleRate: 16000, channels: 1 },
    });
  });

  test("the start frame advertises textInput so a text-only session can open", async () => {
    // The daemon decides whether to degrade a session whose speech-to-text leg
    // is missing by reading this off the start frame, before `ready`. Without
    // it that session is refused outright with `credentials_unavailable` and
    // the text-only fallback is unreachable from this client.
    const ws = await connectAndGetSocket(makeClient());
    ws.open();

    expect(ws.sentJson[0]).toMatchObject({ type: "start", textInput: true });
  });

  test("reports the detected OS surface as the start frame's client", async () => {
    const ws = await connectAndGetSocket(makeClient());
    ws.open();

    // Attribution for the daemon's voice-turn telemetry. It has to be the
    // detected surface rather than a literal: the iOS and macOS apps run this
    // same bundle over this same transport, so a hardcoded "web" would report
    // every native session as a browser one. Under the test DOM (no Electron,
    // no Capacitor) the detected surface is "web".
    expect(ws.sentJson[0]).toMatchObject({ client: "web" });
  });

  test("includes turnDetection in the start frame when provided", async () => {
    const ws = await connectAndGetSocket(makeClient(), {
      assistantId: "assistant-1",
      turnDetection: "server_vad",
    });
    ws.open();
    expect(ws.sentJson).toEqual([
      {
        type: "start",
        client: "web",
        textInput: true,
        audio: { mimeType: "audio/pcm", sampleRate: 16000, channels: 1 },
        turnDetection: "server_vad",
      },
    ]);
  });

  test("includes per-session silenceThresholdMs and bargeInMinSpeechMs in the start frame", async () => {
    const ws = await connectAndGetSocket(makeClient(), {
      assistantId: "assistant-1",
      turnDetection: "server_vad",
      silenceThresholdMs: 1500,
      bargeInMinSpeechMs: 600,
    });
    ws.open();
    expect(ws.sentJson).toEqual([
      {
        type: "start",
        client: "web",
        textInput: true,
        audio: { mimeType: "audio/pcm", sampleRate: 16000, channels: 1 },
        turnDetection: "server_vad",
        silenceThresholdMs: 1500,
        bargeInMinSpeechMs: 600,
      },
    ]);
  });

  test("omits silenceThresholdMs and bargeInMinSpeechMs from the start frame when not provided", async () => {
    const ws = await connectAndGetSocket(makeClient(), {
      assistantId: "assistant-1",
      turnDetection: "server_vad",
    });
    ws.open();
    const frame = ws.sentJson[0]!;
    expect("silenceThresholdMs" in frame).toBe(false);
    expect("bargeInMinSpeechMs" in frame).toBe(false);
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
  async function ready(extra: Record<string, unknown> = {}): Promise<{
    client: LiveVoiceChannelClientType;
    ws: FakeWebSocket;
  }> {
    const client = makeClient();
    const ws = await connectAndGetSocket(client);
    ws.open();
    ws.receive({
      type: "ready",
      seq: 1,
      sessionId: "s1",
      conversationId: "c1",
      ...extra,
    });
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

  test("ready preserves the server's turnDetection echo", async () => {
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
      turnDetection: "server_vad",
    });

    expect(seen).toEqual([
      {
        type: "ready",
        seq: 1,
        sessionId: "sess-1",
        conversationId: "conv-1",
        turnDetection: "server_vad",
      },
    ]);
  });

  /** Per-test event recorder: `record(name)` handlers append into `got[name]`. */
  function makeRecorder() {
    const got: Record<string, unknown[]> = {};
    const record = (name: string) => (f: unknown) => {
      (got[name] ??= []).push(f);
    };
    return { got, record };
  }

  test("dispatches each transcript/text/tts/metrics/archived frame to its event", async () => {
    const { client, ws } = await ready();

    const { got, record } = makeRecorder();
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

    expect(got.sttPartial).toEqual([
      { type: "stt_partial", seq: 2, text: "hel" },
    ]);
    expect(got.sttFinal).toEqual([
      { type: "stt_final", seq: 3, text: "hello" },
    ]);
    expect(got.thinking).toEqual([{ type: "thinking", seq: 4, turnId: "t1" }]);
    expect(got.assistantTextDelta).toEqual([
      { type: "assistant_text_delta", seq: 5, text: "hi" },
    ]);
    expect(got.ttsAudio).toHaveLength(1);
    expect(got.ttsDone).toEqual([{ type: "tts_done", seq: 7, turnId: "t1" }]);
    expect(got.metrics).toHaveLength(1);
    expect(got.archived).toHaveLength(1);
  });

  test("dispatches speech_started / utterance_end / utterance_discarded / turn_cancelled / minimize_room to their events", async () => {
    const { client, ws } = await ready();

    const { got, record } = makeRecorder();
    client.on("speechStarted", record("speechStarted"));
    client.on("utteranceEnd", record("utteranceEnd"));
    client.on("utteranceDiscarded", record("utteranceDiscarded"));
    client.on("turnCancelled", record("turnCancelled"));
    client.on("minimizeRoom", record("minimizeRoom"));

    ws.receive({ type: "speech_started", seq: 2 });
    ws.receive({ type: "utterance_end", seq: 3, reason: "silence" });
    ws.receive({ type: "utterance_end", seq: 4, reason: "max-duration" });
    ws.receive({ type: "utterance_discarded", seq: 5 });
    ws.receive({ type: "turn_cancelled", seq: 6, turnId: "t1" });
    ws.receive({ type: "minimize_room", seq: 7, turnId: "t1" });

    expect(got.speechStarted).toEqual([{ type: "speech_started", seq: 2 }]);
    expect(got.utteranceEnd).toEqual([
      { type: "utterance_end", seq: 3, reason: "silence" },
      { type: "utterance_end", seq: 4, reason: "max-duration" },
    ]);
    expect(got.utteranceDiscarded).toEqual([
      { type: "utterance_discarded", seq: 5 },
    ]);
    expect(got.turnCancelled).toEqual([
      { type: "turn_cancelled", seq: 6, turnId: "t1" },
    ]);
    expect(got.minimizeRoom).toEqual([
      { type: "minimize_room", seq: 7, turnId: "t1" },
    ]);
  });

  test("ignores unknown server frame types without failing the session", async () => {
    const { client, ws } = await ready();
    const errors: unknown[] = [];
    let closedCount = 0;
    client.on("error", (e) => errors.push(e));
    client.on("closed", () => closedCount++);

    ws.receive({ type: "frame_from_the_future", seq: 2 });

    expect(errors).toHaveLength(0);
    expect(closedCount).toBe(0);
    expect(ws.closed).toBe(false);

    // The session stays live: later known frames still dispatch.
    const seen: unknown[] = [];
    client.on("sttPartial", (f) => seen.push(f));
    ws.receive({ type: "stt_partial", seq: 3, text: "still here" });
    expect(seen).toEqual([{ type: "stt_partial", seq: 3, text: "still here" }]);
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

  test("an unknown_type error (older assistant rejecting update_config) is non-fatal and latches off further updates", async () => {
    const { client, ws } = await ready();
    const errors: unknown[] = [];
    let closedCount = 0;
    client.on("error", (e) => errors.push(e));
    client.on("closed", () => closedCount++);

    // A newer client sends update_config; an older daemon rejects the frame.
    client.updateConfig({ silenceThresholdMs: 1400 });
    ws.receive({
      type: "error",
      seq: 10,
      code: "unknown_type",
      message: "Unknown live voice client frame type: update_config",
    });

    // Not fatal: no error surfaced, session stays open, later frames dispatch.
    expect(errors).toEqual([]);
    expect(closedCount).toBe(0);
    expect(ws.closed).toBe(false);

    // Further updateConfig calls are suppressed (no more frames go out).
    const sentBefore = ws.sentJson.length;
    client.updateConfig({ silenceThresholdMs: 1600 });
    expect(ws.sentJson.length).toBe(sentBefore);

    const seen: unknown[] = [];
    client.on("sttPartial", (f) => seen.push(f));
    ws.receive({ type: "stt_partial", seq: 11, text: "still here" });
    expect(seen).toEqual([
      { type: "stt_partial", seq: 11, text: "still here" },
    ]);
  });

  test("attachFrame parks a camera frame while the session is active", async () => {
    const { client, ws } = await ready();

    expect(client.attachFrame("att-1")).toBe(true);
    expect(ws.sentJson.at(-1)).toEqual({
      type: "attach_frame",
      attachmentId: "att-1",
    });
  });

  test("attachFrame unparks with a null id", async () => {
    // What a closing viewfinder sends, so the session stops holding a view of
    // something the user can no longer see.
    const { client, ws } = await ready();

    expect(client.attachFrame(null)).toBe(true);
    expect(ws.sentJson.at(-1)).toEqual({
      type: "attach_frame",
      attachmentId: null,
    });
  });

  test("a rejected attach_frame is swallowed, not filed as a settings or session error", async () => {
    // The bucket problem: an `unknown_type` from a stale build would otherwise
    // latch config updates off, and the daemon's own recoverable refusal would
    // otherwise reach the controller and disturb the turn the frame was meant
    // to ride.
    const { client, ws } = await ready();
    const errors: unknown[] = [];
    client.on("error", (e) => errors.push(e));

    client.attachFrame("att-1");
    ws.receive({
      type: "error",
      seq: 10,
      code: "invalid_frame",
      message: "Could not attach that camera frame to the conversation.",
      frameType: "attach_frame",
      recoverable: true,
    });
    ws.receive({
      type: "error",
      seq: 11,
      code: "unknown_type",
      message: "Unknown live voice client frame type: attach_frame",
      frameType: "attach_frame",
    });

    expect(errors).toEqual([]);
    expect(ws.closed).toBe(false);
    // The settings frame is untouched: neither rejection was about it.
    const sentBefore = ws.sentJson.length;
    client.updateConfig({ silenceThresholdMs: 1600 });
    expect(ws.sentJson.length).toBe(sentBefore + 1);
  });

  test("sendText refuses when the assistant did not echo textInput", async () => {
    // The gate that keeps an `unknown_type` rejection from ever happening: an
    // assistant predating typed turns rejects the frame identically to
    // `update_config`, which would latch in-session settings off.
    const { client, ws } = await ready();
    const sentBefore = ws.sentJson.length;

    expect(client.supportsTextInput).toBe(false);
    expect(client.sendText("hello")).toBe(false);
    expect(ws.sentJson.length).toBe(sentBefore);
  });

  test("sendText sends a text frame when the assistant echoed textInput", async () => {
    const { client, ws } = await ready({ textInput: true });

    expect(client.supportsTextInput).toBe(true);
    expect(client.sendText("what is on my calendar")).toBe(true);
    expect(ws.sentJson.at(-1)).toEqual({
      type: "text",
      text: "what is on my calendar",
    });
  });

  test("sendText marks a turn hidden only when asked", async () => {
    const { client, ws } = await ready({ textInput: true });

    expect(client.sendText("an automatic greeting", { hidden: true })).toBe(
      true,
    );
    expect(ws.sentJson.at(-1)).toEqual({
      type: "text",
      text: "an automatic greeting",
      hidden: true,
    });

    // Omitted rather than `hidden: false`, so a turn the user typed is
    // byte-identical on the wire to one from a client predating the field.
    expect(client.sendText("typed by hand", { hidden: false })).toBe(true);
    expect(ws.sentJson.at(-1)).toEqual({
      type: "text",
      text: "typed by hand",
    });
  });

  test("sendText trims and refuses an empty turn", async () => {
    const { client, ws } = await ready({ textInput: true });

    expect(client.sendText("   \n  ")).toBe(false);
    expect(client.sendText("  padded  ")).toBe(true);
    expect(ws.sentJson.at(-1)).toEqual({ type: "text", text: "padded" });
  });

  test("a text-attributed error does not latch config updates off", async () => {
    // The daemon refuses a typed turn sent mid-reply with a recoverable error
    // carrying frameType "text". Falling through to the unattributed
    // `unknown_type` fallback would silently disable the voice-room settings
    // for the rest of the session.
    const { client, ws } = await ready({ textInput: true });
    const errors: unknown[] = [];
    const rejections: unknown[] = [];
    client.on("error", (e) => errors.push(e));
    client.on("textTurnRejected", (r) => rejections.push(r));

    ws.receive({
      type: "error",
      seq: 10,
      code: "invalid_frame",
      message: "The assistant is busy with the current turn. Send again.",
      frameType: "text",
      recoverable: true,
    });

    // Not surfaced as a session error: the session is fine.
    expect(errors).toEqual([]);
    // But surfaced as a typed-turn rejection, which is the only signal a
    // composer gets that the turn it believed it sent will never be answered.
    expect(rejections).toEqual([
      {
        reason: "busy",
        message: "The assistant is busy with the current turn. Send again.",
      },
    ]);
    // And settings still work.
    const sentBefore = ws.sentJson.length;
    client.updateConfig({ silenceThresholdMs: 1400 });
    expect(ws.sentJson.length).toBe(sentBefore + 1);
  });

  test("an unknown_type text rejection reports unsupported, not busy", async () => {
    // Reachable only if the sendText gate is bypassed, and the two mean
    // different things to a caller: busy can simply be resent, unsupported
    // never will be.
    const { client, ws } = await ready({ textInput: true });
    const rejections: { reason: string }[] = [];
    client.on("textTurnRejected", (r) => rejections.push(r));

    ws.receive({
      type: "error",
      seq: 11,
      code: "unknown_type",
      message: "Unknown live voice client frame type: text",
      frameType: "text",
    });

    expect(rejections.map((r) => r.reason)).toEqual(["unsupported"]);
  });

  test("recoverable error frame emits the error but keeps the session alive", async () => {
    const { client, ws } = await ready();
    const errors: {
      reason: string;
      code?: string;
      message: string;
      recoverable?: boolean;
    }[] = [];
    let closedCount = 0;
    client.on("error", (e) => errors.push(e));
    client.on("closed", () => closedCount++);

    ws.receive({
      type: "error",
      seq: 10,
      code: "invalid_field",
      message: "transient blip",
      recoverable: true,
    });

    expect(errors).toEqual([
      {
        reason: "protocol-error",
        code: "invalid_field",
        message: "transient blip",
        recoverable: true,
      },
    ]);
    expect(closedCount).toBe(0);
    expect(ws.closed).toBe(false);

    // The session stays live: later frames still dispatch.
    const seen: unknown[] = [];
    client.on("sttPartial", (f) => seen.push(f));
    ws.receive({ type: "stt_partial", seq: 11, text: "still here" });
    expect(seen).toEqual([
      { type: "stt_partial", seq: 11, text: "still here" },
    ]);
  });

  test("recoverable error before ready is still fatal", async () => {
    const client = makeClient();
    const ws = await connectAndGetSocket(client);
    ws.open();

    const errors: { recoverable?: boolean }[] = [];
    let closedCount = 0;
    client.on("error", (e) => errors.push(e));
    client.on("closed", () => closedCount++);

    ws.receive({
      type: "error",
      seq: 1,
      code: "invalid_field",
      message: "startup failed",
      recoverable: true,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]!.recoverable).toBeUndefined();
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
        client: "web",
        textInput: true,
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

  test("updateConfig sends an update_config frame with only the provided fields when active", async () => {
    const client = makeClient();
    const ws = await connectAndGetSocket(client);
    ws.open();
    ws.receive({ type: "ready", seq: 1, sessionId: "s", conversationId: "c" });

    client.updateConfig({ silenceThresholdMs: 1400 });

    expect(ws.sentJson.slice(1)).toEqual([
      { type: "update_config", silenceThresholdMs: 1400 },
    ]);
  });

  test("updateConfig is a no-op before the session is active", async () => {
    const client = makeClient();
    const ws = await connectAndGetSocket(client);
    ws.open(); // opened but no `ready` yet → still connecting, not active

    client.updateConfig({ silenceThresholdMs: 1400 });

    // Only the start frame was sent; the update was dropped.
    expect(ws.sentJson).toEqual([
      {
        type: "start",
        client: "web",
        textInput: true,
        audio: { mimeType: "audio/pcm", sampleRate: 16000, channels: 1 },
      },
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

  test("a retryable close before ready forwards the code instead of failing", async () => {
    const client = makeClient();
    const ws = await connectAndGetSocket(client);
    ws.open();

    const errors: unknown[] = [];
    const closes: { code: number | null; reason: string }[] = [];
    client.on("error", (e) => errors.push(e));
    client.on("closed", (info) => closes.push(info));

    // velay closes a reconnect's socket before `ready` because its tunnel is
    // still re-registering — retryable, so the controller must see the code
    // (and keep its reconnect budget), not a connection-failed error.
    ws.emitClose(1013, "assistant tunnel disconnected");

    expect(errors).toHaveLength(0);
    expect(closes).toEqual([
      { code: 1013, reason: "assistant tunnel disconnected" },
    ]);
  });

  test("forwards the far-side close code on the closed event", async () => {
    const client = makeClient();
    const ws = await connectAndGetSocket(client);
    ws.open();
    ws.receive({ type: "ready", seq: 1, sessionId: "s", conversationId: "c" });

    const closes: { code: number | null; reason: string }[] = [];
    client.on("closed", (info) => closes.push(info));

    // velay drops its tunnel to the assistant → retryable 1013 close.
    ws.emitClose(1013, "assistant tunnel disconnected");

    expect(closes).toEqual([
      { code: 1013, reason: "assistant tunnel disconnected" },
    ]);
  });

  test("a locally-initiated close reports a null code", async () => {
    const client = makeClient();
    const ws = await connectAndGetSocket(client);
    ws.open();
    ws.receive({ type: "ready", seq: 1, sessionId: "s", conversationId: "c" });

    const closes: { code: number | null; reason: string }[] = [];
    client.on("closed", (info) => closes.push(info));

    client.close();

    expect(closes).toEqual([{ code: null, reason: "client closed" }]);
  });
});

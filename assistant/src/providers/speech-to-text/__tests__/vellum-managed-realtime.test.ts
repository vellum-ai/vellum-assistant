/**
 * Tests for the vellum managed realtime STT adapter (velay relay).
 *
 * The global WebSocket is replaced with a recording factory so tests can
 * assert on the dialed URL (query auth, no model param) and drive multiple
 * sequential sockets — the session-cap re-dial opens a second connection.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { SttStreamServerEvent } from "../../../stt/types.js";
import { VellumManagedRealtimeTranscriber } from "../vellum-managed-realtime.js";
import type { VelaySpeechConnection } from "../vellum-velay-connection.js";

type WsListener = (...args: unknown[]) => void;

class MockWebSocket {
  readyState = 0;
  bufferedAmount = 0;
  sentData: (string | Uint8Array)[] = [];
  closeCalled = false;

  constructor(
    readonly url: string,
    readonly ctorOptions?: { headers?: Record<string, string> },
  ) {}

  private listeners = new Map<string, WsListener[]>();

  addEventListener(type: string, listener: WsListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: unknown): void {
    const list = this.listeners.get(type);
    if (!list) {
      return;
    }
    const idx = list.indexOf(listener as WsListener);
    if (idx !== -1) {
      list.splice(idx, 1);
    }
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) {
      throw new Error("WebSocket is not open");
    }
    this.sentData.push(data);
  }

  close(): void {
    this.closeCalled = true;
    this.readyState = 3;
  }

  simulateOpen(): void {
    this.readyState = 1;
    for (const l of this.listeners.get("open") ?? []) {
      l();
    }
  }

  simulateMessage(data: string): void {
    for (const l of this.listeners.get("message") ?? []) {
      l({ data });
    }
  }

  simulateClose(code = 1000, reason = ""): void {
    this.readyState = 3;
    for (const l of this.listeners.get("close") ?? []) {
      l({ code, reason });
    }
  }
}

function resultsFrame(
  transcript: string,
  options: { is_final?: boolean } = {},
): string {
  return JSON.stringify({
    type: "Results",
    is_final: options.is_final ?? false,
    channel: { alternatives: [{ transcript, confidence: 0.9 }] },
  });
}

function velayErrorFrame(code: string, detail = ""): string {
  return JSON.stringify({ type: "velay_error", code, detail });
}

const CONNECTION: VelaySpeechConnection = {
  wsBaseUrl: "wss://velay.test",
  httpBaseUrl: "https://velay.test",
  apiKey: "vk-secret",
};

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("VellumManagedRealtimeTranscriber", () => {
  let sockets: MockWebSocket[];
  let originalWebSocket: unknown;
  let originalFetch: unknown;

  beforeEach(() => {
    sockets = [];
    originalWebSocket = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = class {
      constructor(url: string, options?: { headers?: Record<string, string> }) {
        const ws = new MockWebSocket(url, options);
        sockets.push(ws);
        return ws;
      }
    };
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch as typeof fetch;
  });

  function collector(): {
    events: SttStreamServerEvent[];
    onEvent: (e: SttStreamServerEvent) => void;
  } {
    const events: SttStreamServerEvent[] = [];
    return { events, onEvent: (e) => events.push(e) };
  }

  async function startAdapter(
    options: ConstructorParameters<
      typeof VellumManagedRealtimeTranscriber
    >[1] = {},
  ) {
    const adapter = new VellumManagedRealtimeTranscriber(CONNECTION, options);
    const { events, onEvent } = collector();
    const startPromise = adapter.start(onEvent);
    sockets[0]!.simulateOpen();
    await startPromise;
    return { adapter, events };
  }

  test("dials the velay STT route with query auth and no model param", async () => {
    await startAdapter({ sampleRate: 24000 });

    const ws = sockets[0]!;
    const url = new URL(ws.url);
    expect(url.origin).toBe("wss://velay.test");
    expect(url.pathname).toBe("/v1/speech/stt/stream");
    expect(url.searchParams.get("key")).toBe("vk-secret");
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("24000");
    expect(url.searchParams.get("channels")).toBe("1");
    // velay pins the model server-side and rejects the param.
    expect(url.searchParams.has("model")).toBe(false);
    // velay's allowlist has no utterance_end_ms.
    expect(url.searchParams.has("utterance_end_ms")).toBe(false);
    // Auth travels in the URL, not a Deepgram Token header.
    expect(ws.ctorOptions?.headers?.Authorization).toBeUndefined();
  });

  test("streams interim and final transcripts through the shared pipeline", async () => {
    const { events } = await startAdapter();

    sockets[0]!.simulateMessage(resultsFrame("hello wor"));
    sockets[0]!.simulateMessage(
      resultsFrame("hello world", { is_final: true }),
    );

    expect(events).toEqual([
      expect.objectContaining({ type: "partial", text: "hello wor" }),
      expect.objectContaining({ type: "final", text: "hello world" }),
    ]);
  });

  test("maps a mid-stream velay_error to a categorized SttError", async () => {
    const { events } = await startAdapter();

    sockets[0]!.simulateMessage(
      velayErrorFrame("insufficient_balance", "balance is 0"),
    );
    sockets[0]!.simulateClose(1011, "insufficient_balance");

    expect(events).toEqual([
      expect.objectContaining({
        type: "error",
        category: "provider-error",
        message: expect.stringContaining("credits"),
      }),
      { type: "closed" },
    ]);
  });

  test("maps invalid_key to an auth error", async () => {
    const { events } = await startAdapter();

    sockets[0]!.simulateMessage(velayErrorFrame("invalid_key"));
    sockets[0]!.simulateClose(1008, "invalid_key");

    expect(events[0]).toEqual(
      expect.objectContaining({
        type: "error",
        category: "auth",
        message: expect.stringContaining("platform connect"),
      }),
    );
  });

  test("drains the capped session's close cleanup before re-dialing", async () => {
    // In utterance-boundary mode, committed segments are withheld until a
    // boundary; the inner adapter flushes them during its close cleanup
    // (after the swallowed cap error, before `closed`). The swap must not
    // drop that flush — or an outstanding finalize's settlement.
    const { adapter, events } = await startAdapter({
      utteranceBoundaryFinals: true,
    });

    sockets[0]!.simulateMessage(resultsFrame("tail text", { is_final: true }));
    adapter.finalizeUtterance();
    sockets[0]!.simulateMessage(
      velayErrorFrame("session_duration_exceeded", "30m cap"),
    );
    sockets[0]!.simulateClose(1000, "session_duration_exceeded");

    await tick();
    expect(sockets).toHaveLength(2);

    expect(events).toEqual([
      expect.objectContaining({ type: "final", text: "tail text" }),
      { type: "finalized" },
    ]);
  });

  test("re-dials transparently when velay's session cap closes the stream", async () => {
    const { adapter, events } = await startAdapter({ sampleRate: 16000 });

    // Velay settles the in-flight utterance before closing.
    sockets[0]!.simulateMessage(resultsFrame("first leg", { is_final: true }));
    sockets[0]!.simulateMessage(
      velayErrorFrame("session_duration_exceeded", "30m cap"),
    );
    sockets[0]!.simulateClose(1000, "session_duration_exceeded");

    // Audio during the swap is dropped, not an error.
    adapter.sendAudio(Buffer.from([0, 1]), "audio/pcm");

    await tick();
    expect(sockets).toHaveLength(2);
    sockets[1]!.simulateOpen();
    await tick();

    sockets[1]!.simulateMessage(resultsFrame("second leg", { is_final: true }));

    expect(events).toEqual([
      expect.objectContaining({ type: "final", text: "first leg" }),
      expect.objectContaining({ type: "final", text: "second leg" }),
    ]);
    // The second dial reuses the same auth/params.
    expect(new URL(sockets[1]!.url).searchParams.get("key")).toBe("vk-secret");
  });

  test("finalize during a re-dial settles immediately", async () => {
    const { adapter, events } = await startAdapter();

    sockets[0]!.simulateMessage(velayErrorFrame("session_duration_exceeded"));
    sockets[0]!.simulateClose(1000, "session_duration_exceeded");

    adapter.finalizeUtterance();
    expect(events).toEqual([{ type: "finalized" }]);
  });

  test("stop during a re-dial closes exactly once", async () => {
    const { adapter, events } = await startAdapter();

    sockets[0]!.simulateMessage(velayErrorFrame("session_duration_exceeded"));
    sockets[0]!.simulateClose(1000, "session_duration_exceeded");

    adapter.stop();
    await tick();
    if (sockets.length > 1) {
      sockets[1]!.simulateOpen();
      await tick();
    }

    expect(events.filter((e) => e.type === "closed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
  });

  test("a failed dial surfaces velay's HTTP rejection via the probe", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: "insufficient_balance",
          detail: "balance is 0",
        }),
        { status: 402 },
      )) as unknown as typeof fetch;

    const adapter = new VellumManagedRealtimeTranscriber(CONNECTION);
    const startPromise = adapter.start(() => {});
    sockets[0]!.simulateClose(1006, "");

    await expect(startPromise).rejects.toThrow(/credits/);
  });

  test("connect failures never leak the API key", async () => {
    globalThis.fetch = (async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;

    const adapter = new VellumManagedRealtimeTranscriber(CONNECTION);
    const startPromise = adapter.start(() => {});
    // Bun embeds the dialed URL (which carries ?key= under query auth) in
    // connection-failure details; the adapter must redact it everywhere.
    sockets[0]!.simulateClose(1006, `connect failed: ${sockets[0]!.url}`);

    await expect(startPromise).rejects.toThrow();
    const err = await startPromise.catch((e: Error) => e);
    expect(err.message).not.toContain("vk-secret");
    expect(err.message).toContain("key=***");
  });

  test("a failed dial with no HTTP rejection keeps the transport error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const adapter = new VellumManagedRealtimeTranscriber(CONNECTION);
    const startPromise = adapter.start(() => {});
    sockets[0]!.simulateClose(1006, "");

    await expect(startPromise).rejects.toThrow(/closed before open/);
  });
});

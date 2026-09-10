/**
 * Idle-watchdog behavior of SseConnection: a silently stalled SSE
 * stream (open fetch, no events or heartbeat comments) is aborted and
 * retried through the ordinary reconnect path.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../client-identity.js", () => ({
  getClientRegistrationHeaders: async () => ({
    "X-Vellum-Client-Id": "ext-test-id",
    "X-Vellum-Interface-Id": "chrome-extension",
  }),
  getClientId: async () => "ext-test-id",
}));

import { SseConnection } from "../sse-connection.js";

const HEARTBEAT_FRAME = ": heartbeat\n\n";
const DATA_FRAME = 'data: {"message":{"type":"noop"}}\n\n';

function abortSignalOf(init?: RequestInit): AbortSignal | undefined {
  return init?.signal ?? undefined;
}

function sseResponse(
  write: (enqueue: (chunk: string) => void) => void,
  signal?: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const onAbort = () => {
        try {
          controller.error(new DOMException("Aborted", "AbortError"));
        } catch {
          // Already closed or errored.
        }
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      write((chunk) => {
        controller.enqueue(encoder.encode(chunk));
      });
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hungSseResponse(signal?: AbortSignal): Response {
  return sseResponse(() => {
    // Never enqueue, never close: the watchdog is the only way out.
  }, signal);
}

describe("SseConnection idle watchdog", () => {
  const originalFetch = globalThis.fetch;
  let connection: SseConnection | null = null;

  beforeEach(() => {
    connection = null;
  });

  afterEach(() => {
    connection?.close();
    connection = null;
    globalThis.fetch = originalFetch;
  });

  test("aborts a stream that opens then goes silent and reconnects", async () => {
    let fetchCount = 0;
    const idleTimeouts: number[] = [];
    const closes: number[] = [];
    const opens: number[] = [];

    globalThis.fetch = (async (_input, init) => {
      fetchCount += 1;
      return sseResponse((enqueue) => {
        enqueue(HEARTBEAT_FRAME);
      }, abortSignalOf(init));
    }) as typeof fetch;

    connection = new SseConnection({
      mode: { kind: "self-hosted", runtimeUrl: "http://127.0.0.1:7830", token: "t" },
      idleTimeoutMs: 60,
      reconnectBaseDelayMs: 20,
      onMessage: () => {},
      onOpen: () => {
        opens.push(Date.now());
      },
      onClose: () => {
        closes.push(Date.now());
      },
      onIdleTimeout: () => {
        idleTimeouts.push(Date.now());
      },
    });
    connection.start();

    await wait(40);
    expect(opens.length).toBe(1);
    expect(idleTimeouts.length).toBe(0);
    expect(connection.isOpen()).toBe(true);

    await wait(80);
    expect(idleTimeouts.length).toBe(1);
    expect(closes.length).toBeGreaterThanOrEqual(1);
    expect(fetchCount).toBeGreaterThanOrEqual(2);
  });

  test("aborts a stream that never yields a byte after headers", async () => {
    let fetchCount = 0;
    const idleTimeouts: number[] = [];

    globalThis.fetch = (async (_input, init) => {
      fetchCount += 1;
      return hungSseResponse(abortSignalOf(init));
    }) as typeof fetch;

    connection = new SseConnection({
      mode: { kind: "self-hosted", runtimeUrl: "http://127.0.0.1:7830", token: "t" },
      idleTimeoutMs: 50,
      reconnectBaseDelayMs: 20,
      onMessage: () => {},
      onOpen: () => {},
      onClose: () => {},
      onIdleTimeout: () => {
        idleTimeouts.push(Date.now());
      },
    });
    connection.start();

    await wait(200);
    expect(idleTimeouts.length).toBeGreaterThanOrEqual(1);
    expect(fetchCount).toBeGreaterThanOrEqual(2);
  });

  test("heartbeat comments keep the stream from being treated as stalled", async () => {
    const idleTimeouts: number[] = [];
    const stream: { push: ((chunk: string) => void) | null } = { push: null };

    globalThis.fetch = (async (_input, init) =>
      sseResponse((push) => {
        stream.push = push;
        push(HEARTBEAT_FRAME);
      }, abortSignalOf(init))) as typeof fetch;

    connection = new SseConnection({
      mode: { kind: "self-hosted", runtimeUrl: "http://127.0.0.1:7830", token: "t" },
      idleTimeoutMs: 80,
      reconnectBaseDelayMs: 20,
      onMessage: () => {},
      onOpen: () => {},
      onClose: () => {},
      onIdleTimeout: () => {
        idleTimeouts.push(Date.now());
      },
    });
    connection.start();

    await wait(20);
    for (let i = 0; i < 4; i++) {
      stream.push?.(HEARTBEAT_FRAME);
      await wait(40);
    }

    expect(idleTimeouts.length).toBe(0);
    expect(connection.isOpen()).toBe(true);
  });

  test("data frames keep the stream from being treated as stalled", async () => {
    const idleTimeouts: number[] = [];
    const messages: unknown[] = [];
    const stream: { push: ((chunk: string) => void) | null } = { push: null };

    globalThis.fetch = (async (_input, init) =>
      sseResponse((push) => {
        stream.push = push;
        push(DATA_FRAME);
      }, abortSignalOf(init))) as typeof fetch;

    connection = new SseConnection({
      mode: { kind: "self-hosted", runtimeUrl: "http://127.0.0.1:7830", token: "t" },
      idleTimeoutMs: 80,
      reconnectBaseDelayMs: 20,
      onMessage: (data) => {
        messages.push(data);
      },
      onOpen: () => {},
      onClose: () => {},
      onIdleTimeout: () => {
        idleTimeouts.push(Date.now());
      },
    });
    connection.start();

    await wait(20);
    for (let i = 0; i < 4; i++) {
      stream.push?.(DATA_FRAME);
      await wait(40);
    }

    expect(messages.length).toBeGreaterThan(0);
    expect(idleTimeouts.length).toBe(0);
    expect(connection.isOpen()).toBe(true);
  });

  test("close() stops reconnect after a stall", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async (_input, init) => {
      fetchCount += 1;
      return hungSseResponse(abortSignalOf(init));
    }) as typeof fetch;

    connection = new SseConnection({
      mode: { kind: "self-hosted", runtimeUrl: "http://127.0.0.1:7830", token: "t" },
      idleTimeoutMs: 40,
      reconnectBaseDelayMs: 20,
      onMessage: () => {},
      onOpen: () => {},
      onClose: () => {},
    });
    connection.start();
    await wait(20);
    connection.close();
    const fetchesAtClose = fetchCount;
    await wait(120);
    expect(fetchCount).toBe(fetchesAtClose);
  });

  test("setMode does not treat the aborted prior fetch as an unexpected close", async () => {
    let fetchCount = 0;
    const closes: Array<string | undefined> = [];

    globalThis.fetch = (async (_input, init) => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Promise((_resolve, reject) => {
          const signal = abortSignalOf(init);
          const fail = () => {
            reject(new DOMException("Aborted", "AbortError"));
          };
          if (signal?.aborted) {
            fail();
            return;
          }
          signal?.addEventListener("abort", fail, { once: true });
        });
      }
      return new Response("Authentication failed (401).", { status: 401 });
    }) as typeof fetch;

    connection = new SseConnection({
      mode: { kind: "self-hosted", runtimeUrl: "http://127.0.0.1:7830", token: "t" },
      idleTimeoutMs: 5_000,
      reconnectBaseDelayMs: 20,
      onMessage: () => {},
      onOpen: () => {},
      onClose: (authError) => {
        closes.push(authError);
      },
    });
    connection.start();
    await wait(20);
    connection.setMode({
      kind: "self-hosted",
      runtimeUrl: "http://127.0.0.1:7830",
      token: "t2",
    });
    await wait(80);

    expect(closes.filter((message) => message !== undefined).length).toBe(1);
    expect(fetchCount).toBe(2);
  });
});

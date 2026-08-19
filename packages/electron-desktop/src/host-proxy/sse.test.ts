import { afterEach, describe, expect, test } from "bun:test";

const MOCK_DEVICE_ID = "test-device-00000000-0000-0000-0000-000000000000";
const clientHeaders = () => ({
  "X-Vellum-Client-Id": MOCK_DEVICE_ID,
  "X-Vellum-Interface-Id": "macos",
  "X-Vellum-Machine-Name": "Example Mac",
});

const { HostProxySseClient } = await import("./sse");
type HostProxySseMessage = import("./sse").HostProxySseMessage;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a ReadableStream that pushes encoded SSE chunks then closes. */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** Build a ReadableStream that yields chunks on demand via a push function. */
function controllableStream(): {
  stream: ReadableStream<Uint8Array>;
  push: (text: string) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let ctrl: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    stream,
    push: (text: string) => ctrl.enqueue(encoder.encode(text)),
    close: () => ctrl.close(),
  };
}

/** Create a mock fetch that returns a streaming SSE response. */
function mockFetch(
  body: ReadableStream<Uint8Array>,
  status = 200,
): typeof globalThis.fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { "Content-Type": "text/event-stream" },
    })) as unknown as typeof globalThis.fetch;
}

/** Flush pending microtasks / timers so stream processing can complete. */
async function flush(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HostProxySseClient", () => {
  let client: InstanceType<typeof HostProxySseClient>;

  afterEach(() => {
    client?.disconnect();
  });

  // -- Basic SSE parsing --------------------------------------------------

  test("parses data frames and delivers messages via callback", async () => {
    const messages: HostProxySseMessage[] = [];
    const body = sseStream([
      'data: {"type":"ping"}\n\n',
      'data: {"type":"host_bash_request","conversationId":"c1"}\n\n',
    ]);

    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: mockFetch(body),
    });
    client.setMessageCallback((m) => messages.push(m));
    client.connect();

    await flush(50);

    expect(messages).toHaveLength(2);
    expect(messages[0]!.type).toBe("ping");
    expect(messages[1]!.type).toBe("host_bash_request");
  });

  test("ignores heartbeat comments", async () => {
    const messages: HostProxySseMessage[] = [];
    const body = sseStream([
      ": heartbeat\n",
      'data: {"type":"ping"}\n\n',
      ": another heartbeat\n",
    ]);

    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: mockFetch(body),
    });
    client.setMessageCallback((m) => messages.push(m));
    client.connect();

    await flush(50);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("ping");
  });

  test("skips malformed JSON data lines", async () => {
    const messages: HostProxySseMessage[] = [];
    const body = sseStream([
      "data: not json\n\n",
      'data: {"type":"ok"}\n\n',
    ]);

    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: mockFetch(body),
    });
    client.setMessageCallback((m) => messages.push(m));
    client.connect();

    await flush(50);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("ok");
  });

  // -- Connection state ---------------------------------------------------

  test("isConnected reflects stream state", async () => {
    const { stream, close } = controllableStream();
    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: mockFetch(stream),
    });

    expect(client.isConnected).toBe(false);
    client.connect();

    // Wait for the fetch response to resolve
    await flush(50);
    expect(client.isConnected).toBe(true);

    close();
    await flush(50);
    // After stream closes, connected should be false (reconnect may be scheduled
    // but the stream itself is down).
    expect(client.isConnected).toBe(false);
  });

  // -- Connected notifications --------------------------------------------

  test("onConnected fires when the stream goes live, not when connect is called", async () => {
    const { stream } = controllableStream();
    let connectedCount = 0;

    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: mockFetch(stream),
      onConnected: () => {
        connectedCount++;
      },
    });

    client.connect();
    // connect() only starts the fetch, so nothing is subscribed yet.
    expect(connectedCount).toBe(0);
    expect(client.isConnected).toBe(false);

    await flush(50);

    expect(connectedCount).toBe(1);
    expect(client.isConnected).toBe(true);
  });

  test("onConnected fires again on every reconnect", async () => {
    const connectedStates: boolean[] = [];
    let fetchCount = 0;

    const fakeFetch: typeof globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(sseStream([`data: {"type":"n${fetchCount}"}\n\n`]), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;

    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: fakeFetch,
      onConnected: () => {
        connectedStates.push(client.isConnected);
      },
    });
    client.connect();

    // Each stream closes as soon as it is drained, so the client redials.
    await flush(1_500);

    expect(connectedStates.length).toBeGreaterThanOrEqual(2);
    // The stream is live whenever the callback runs, so a subscriber can act
    // on it straight away.
    expect(connectedStates.every((connected) => connected)).toBe(true);
  });

  test("a throwing onConnected does not take the stream down", async () => {
    const messages: HostProxySseMessage[] = [];
    const body = sseStream(['data: {"type":"ping"}\n\n']);

    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: mockFetch(body),
      onConnected: () => {
        throw new Error("subscriber blew up");
      },
    });
    client.setMessageCallback((m) => messages.push(m));
    client.connect();

    await flush(50);

    expect(messages.map((m) => m.type)).toEqual(["ping"]);
  });

  // -- Reconnection on error ---------------------------------------------

  test("reconnects with backoff on fetch failure", async () => {
    let fetchCount = 0;
    const messages: HostProxySseMessage[] = [];

    const fakeFetch: typeof globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount < 3) {
        throw new Error("network error");
      }
      // Third attempt succeeds
      return new Response(sseStream(['data: {"type":"recovered"}\n\n']), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;

    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: fakeFetch,
    });
    client.setMessageCallback((m) => messages.push(m));
    client.connect();

    // Wait for reconnect attempts (1s + 2s backoff)
    await flush(4_000);

    expect(fetchCount).toBeGreaterThanOrEqual(3);
    expect(messages.some((m) => m.type === "recovered")).toBe(true);
  });

  test("reconnects on non-200 response", async () => {
    let fetchCount = 0;
    const fakeFetch: typeof globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response(sseStream(['data: {"type":"ok"}\n\n']), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;

    const messages: HostProxySseMessage[] = [];
    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: fakeFetch,
    });
    client.setMessageCallback((m) => messages.push(m));
    client.connect();

    await flush(2_000);

    expect(fetchCount).toBeGreaterThanOrEqual(2);
    expect(messages.some((m) => m.type === "ok")).toBe(true);
  });

  test("disconnect during a slow token refresh stops the pending reconnect", async () => {
    let fetchCount = 0;
    const fakeFetch: typeof globalThis.fetch = (async () => {
      fetchCount++;
      // Every attempt fails, driving the client into the reconnect path
      throw new Error("network error");
    }) as unknown as typeof globalThis.fetch;

    let refreshStarted = false;
    let resolveRefresh: (token: string | null) => void = () => {};
    const onRefreshToken = (): Promise<string | null> => {
      refreshStarted = true;
      return new Promise((r) => {
        resolveRefresh = r;
      });
    };

    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: fakeFetch,
      onRefreshToken,
    });
    client.connect();

    // First attempt fails immediately; the reconnect timer fires after ~1s
    // and blocks awaiting the slow token refresh.
    await flush(1_200);
    expect(fetchCount).toBe(1);
    expect(refreshStarted).toBe(true);

    // Disconnect while the refresh is still in flight, then let it complete.
    client.disconnect();
    resolveRefresh("fresh-token");
    await flush(200);

    // The stale client must not dial the old eventsUrl again.
    expect(fetchCount).toBe(1);
  });

  // -- Idle watchdog ------------------------------------------------------

  test("idle watchdog triggers reconnect when no traffic arrives", async () => {
    let fetchCount = 0;
    const { stream, push } = controllableStream();

    const fakeFetch: typeof globalThis.fetch = (async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      // Second connect: return a fresh stream that closes immediately
      return new Response(sseStream(['data: {"type":"reconnected"}\n\n']), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;

    const messages: HostProxySseMessage[] = [];
    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: fakeFetch,
      idleTimeoutMs: 200,
      idleCheckIntervalMs: 100,
    });
    client.setMessageCallback((m) => messages.push(m));
    client.connect();

    // Push initial data so stream is established
    await flush(50);
    push('data: {"type":"initial"}\n\n');
    await flush(50);

    // Wait for idle timeout (200ms) + check interval (100ms) + reconnect buffer
    await flush(1_500);

    expect(fetchCount).toBeGreaterThanOrEqual(2);
    expect(messages.some((m) => m.type === "reconnected")).toBe(true);
  });

  // -- Disconnect ---------------------------------------------------------

  test("disconnect cancels timers and stream", async () => {
    const { stream } = controllableStream();
    let fetchCount = 0;

    const fakeFetch: typeof globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;

    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: fakeFetch,
    });
    client.connect();
    await flush(50);
    expect(client.isConnected).toBe(true);

    client.disconnect();
    expect(client.isConnected).toBe(false);

    // Wait to confirm no reconnect happens
    await flush(3_000);
    expect(fetchCount).toBe(1);
  });

  // -- Request headers ----------------------------------------------------

  test("sends correct headers for local connection", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    const fakeFetch: typeof globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedUrl = String(input);
      const h = init?.headers as Record<string, string> | undefined;
      if (h) capturedHeaders = { ...h };
      return new Response(sseStream([]), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;

    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:8080/v1/events",
      authHeaders: () => ({ Authorization: "Bearer my-token" }),
      clientHeaders,
      fetch: fakeFetch,
    });
    client.connect();
    await flush(50);

    expect(capturedUrl).toBe("http://127.0.0.1:8080/v1/events");
    expect(capturedHeaders["Authorization"]).toBe("Bearer my-token");
    expect(capturedHeaders["Accept"]).toBe(
      "text/event-stream, application/json",
    );
    expect(capturedHeaders["X-Vellum-Client-Id"]).toBe(MOCK_DEVICE_ID);
    expect(capturedHeaders["X-Vellum-Interface-Id"]).toBe("macos");
    expect(capturedHeaders["X-Vellum-Machine-Name"]).toBeTruthy();
  });

  test("sends correct headers for cloud connection", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    const fakeFetch: typeof globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedUrl = String(input);
      const h = init?.headers as Record<string, string> | undefined;
      if (h) capturedHeaders = { ...h };
      return new Response(sseStream([]), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;

    client = new HostProxySseClient({
      eventsUrl: "https://platform.vellum.ai/v1/assistants/asst-123/events",
      authHeaders: () => ({ "X-Session-Token": "session-tok-abc" }),
      clientHeaders,
      fetch: fakeFetch,
    });
    client.connect();
    await flush(50);

    expect(capturedUrl).toBe("https://platform.vellum.ai/v1/assistants/asst-123/events");
    expect(capturedHeaders["X-Session-Token"]).toBe("session-tok-abc");
    expect(capturedHeaders["Authorization"]).toBeUndefined();
    expect(capturedHeaders["X-Vellum-Client-Id"]).toBe(MOCK_DEVICE_ID);
    expect(capturedHeaders["X-Vellum-Interface-Id"]).toBe("macos");
  });

  test("retries with compatibility headers when the interface is rejected", async () => {
    const capturedInterfaces: string[] = [];
    const { stream } = controllableStream();
    const fakeFetch: typeof globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const headers = init?.headers as Record<string, string>;
      capturedInterfaces.push(headers["X-Vellum-Interface-Id"]!);
      if (capturedInterfaces.length === 1) {
        return new Response(null, { status: 400 });
      }
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;

    client = new HostProxySseClient({
      eventsUrl: "https://platform.vellum.ai/v1/assistants/asst-123/events",
      authHeaders: () => ({ "X-Session-Token": "session-token" }),
      clientHeaders: () => ({ "X-Vellum-Interface-Id": "windows" }),
      fallbackClientHeaders: () => ({
        "X-Vellum-Interface-Id": "macos",
      }),
      fetch: fakeFetch,
    });
    client.connect();
    await flush(50);

    expect(capturedInterfaces).toEqual(["windows", "macos"]);
    expect(client.isConnected).toBe(true);
  });

  test("does not use compatibility headers for authentication failures", async () => {
    const capturedInterfaces: string[] = [];
    const fakeFetch: typeof globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const headers = init?.headers as Record<string, string>;
      capturedInterfaces.push(headers["X-Vellum-Interface-Id"]!);
      return new Response(null, { status: 401 });
    }) as unknown as typeof globalThis.fetch;

    client = new HostProxySseClient({
      eventsUrl: "https://platform.vellum.ai/v1/assistants/asst-123/events",
      authHeaders: () => ({ "X-Session-Token": "session-token" }),
      clientHeaders: () => ({ "X-Vellum-Interface-Id": "windows" }),
      fallbackClientHeaders: () => ({
        "X-Vellum-Interface-Id": "macos",
      }),
      fetch: fakeFetch,
    });
    client.connect();
    await flush(50);

    expect(capturedInterfaces).toEqual(["windows"]);
    expect(client.isConnected).toBe(false);
  });

  // -- Chunked data handling ----------------------------------------------

  test("handles data split across multiple chunks", async () => {
    const messages: HostProxySseMessage[] = [];
    // JSON payload split across two chunks
    const body = sseStream([
      'data: {"type":"sp',
      'lit_msg","val":1}\n\n',
    ]);

    client = new HostProxySseClient({
      eventsUrl: "http://127.0.0.1:9999/v1/events",
      authHeaders: () => ({ Authorization: "Bearer tok" }),
      fetch: mockFetch(body),
    });
    client.setMessageCallback((m) => messages.push(m));
    client.connect();

    await flush(50);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe("split_msg");
  });
});

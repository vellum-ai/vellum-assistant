/**
 * Smoke tests for cliIpcCallBinary and cliIpcCallStream.
 *
 * Uses a real AssistantIpcServer with fixture routes injected via module mocks.
 * Pattern mirrors cli-ipc.test.ts.
 */

import { Socket } from "node:net";
import { afterEach, describe, expect, mock, test } from "bun:test";

// Ensure tests use a workspace-based socket path rather than any pre-existing
// system socket (e.g. stale root-owned /run/assistant-ipc/assistant.sock).
delete process.env.ASSISTANT_IPC_SOCKET_DIR;

import { AssistantIpcServer } from "../assistant-server.js";
import { cliIpcCallBinary, cliIpcCallStream } from "../cli-client.js";
import { writeMessage } from "../ipc-framing.js";

// ---------------------------------------------------------------------------
// Fixture routes
// ---------------------------------------------------------------------------

const STREAM_FIXTURE_ROUTE = {
  operationId: "stream_fixture",
  endpoint: "/stream-fixture",
  method: "GET" as const,
  handler: async () => ({
    stream: new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("chunk1"));
        ctrl.enqueue(new TextEncoder().encode("chunk2"));
        ctrl.close();
      },
    }),
    headers: { "x-fixture": "streaming" },
  }),
};

const BINARY_FIXTURE_ROUTE = {
  operationId: "binary_fixture",
  endpoint: "/binary-fixture",
  method: "GET" as const,
  handler: async () => ({
    binary: new TextEncoder().encode("hello"),
    headers: { "content-type": "application/octet-stream" },
  }),
};

let slowStreamAborted = false;
const SLOW_STREAM_FIXTURE_ROUTE = {
  operationId: "slow_stream_fixture",
  endpoint: "/slow-stream-fixture",
  method: "GET" as const,
  // Delays 50 ms before returning the stream so the test can destroy the
  // socket first, exercising the sendStreamingResponse early-return path.
  handler: async (params: Record<string, unknown> | undefined) => {
    slowStreamAborted = false;
    const signal = (params as { abortSignal?: AbortSignal })?.abortSignal;
    signal?.addEventListener("abort", () => { slowStreamAborted = true; }, { once: true });
    await new Promise((r) => setTimeout(r, 50));
    return {
      stream: new ReadableStream<Uint8Array>({ start(ctrl) { ctrl.close(); } }),
      headers: {} as Record<string, string>,
    };
  },
};

let cancelAborted = false;
const CANCEL_FIXTURE_ROUTE = {
  operationId: "cancel_fixture",
  endpoint: "/cancel-fixture",
  method: "GET" as const,
  // Returns a stream immediately that holds open until the abortSignal fires.
  // This lets cliIpcCallStream resolve (opening envelope arrives), then the
  // test can call abort() and verify the signal is delivered to the handler.
  handler: async (params: Record<string, unknown> | undefined) => {
    cancelAborted = false;
    const signal = (params as { abortSignal?: AbortSignal })?.abortSignal;
    return {
      stream: new ReadableStream<Uint8Array>({
        start(ctrl) {
          if (signal?.aborted) {
            cancelAborted = true;
            ctrl.error(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => {
            cancelAborted = true;
            ctrl.error(new DOMException("Aborted", "AbortError"));
          }, { once: true });
          // Hold open — no close() until aborted
        },
      }),
      headers: {} as Record<string, string>,
    };
  },
};

mock.module("../../runtime/routes/index.js", () => ({
  ROUTES: [STREAM_FIXTURE_ROUTE, BINARY_FIXTURE_ROUTE, CANCEL_FIXTURE_ROUTE, SLOW_STREAM_FIXTURE_ROUTE],
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let server: AssistantIpcServer | null = null;

async function startServer(): Promise<void> {
  server = new AssistantIpcServer({ watchdogIntervalMs: 0 });
  await server.start();
  await new Promise((r) => setTimeout(r, 50));
}

afterEach(() => {
  server?.stop();
  server = null;
  cancelAborted = false;
  slowStreamAborted = false;
});

// ---------------------------------------------------------------------------
// cliIpcCallStream tests
// ---------------------------------------------------------------------------

describe("cliIpcCallStream", () => {
  test("resolves ok with correct headers", async () => {
    await startServer();
    const r = await cliIpcCallStream("stream_fixture");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.headers["x-fixture"]).toBe("streaming");
    // Drain the body to avoid resource leaks
    const reader = r.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  });

  test("chunks arrive in order", async () => {
    await startServer();
    const r = await cliIpcCallStream("stream_fixture");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const chunks: string[] = [];
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(dec.decode(value));
    }
    expect(chunks.join("")).toBe("chunk1chunk2");
  });

  test("abort() cancels mid-stream", async () => {
    await startServer();
    const r = await cliIpcCallStream("cancel_fixture");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const bodyReader = r.body.getReader();
    r.abort();

    // The stream should error after abort — either DOMException or connection close
    try {
      await bodyReader.read();
    } catch (err) {
      expect(err).toBeDefined();
    }

    // Give the server a tick to process the $cancel envelope
    await new Promise((res) => setTimeout(res, 200));
    expect(cancelAborted).toBe(true);
  });

  test("returns ok: false when no server", async () => {
    const r = await cliIpcCallStream("stream_fixture");
    expect(r.ok).toBe(false);
  });

  test("body.cancel() sends $cancel to server (Fix F)", async () => {
    await startServer();
    const r = await cliIpcCallStream("cancel_fixture");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Cancel the ReadableStream body — the cancel() callback should call abort()
    // which sends $cancel on the wire and ends the socket.
    await r.body.cancel();

    // Give the server a tick to process the $cancel envelope
    await new Promise((res) => setTimeout(res, 200));
    expect(cancelAborted).toBe(true);
  });

  test("abortController cleaned up when socket destroyed before stream starts (Fix E)", async () => {
    await startServer();
    const socketPath = server!.getSocketPath();

    // Use a raw socket so we can destroy it immediately after sending the
    // request, before slow_stream_fixture's 50ms handler delay expires.
    const rawSocket = new Socket();
    await new Promise<void>((res) => rawSocket.connect(socketPath, res));
    writeMessage(rawSocket, { id: crypto.randomUUID(), method: "slow_stream_fixture", params: {} });
    rawSocket.destroy();

    // Wait for the handler to complete and sendStreamingResponse to run
    await new Promise((res) => setTimeout(res, 200));

    // Handler's abortSignal fired → confirms abort+delete ran in the
    // sendStreamingResponse early-return (socket already destroyed) path.
    expect(slowStreamAborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cliIpcCallBinary tests
// ---------------------------------------------------------------------------

describe("cliIpcCallBinary", () => {
  test("returns bytes from binary route", async () => {
    await startServer();
    const r = await cliIpcCallBinary("binary_fixture");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(new TextDecoder().decode(r.bytes)).toBe("hello");
    expect(r.headers["content-type"]).toBe("application/octet-stream");
  });

  test("returns ok: false when no server", async () => {
    const r = await cliIpcCallBinary("binary_fixture");
    expect(r.ok).toBe(false);
  });
});

/**
 * IPC streaming smoke test for the inference_send route.
 *
 * Uses a real AssistantIpcServer with a fixture route injected via module mock.
 * Pattern mirrors streaming-client.test.ts.
 *
 * Validates:
 *   - cliIpcCallStream resolves ok: true
 *   - Chunks accumulate to the correct text
 *   - Stream can be aborted cleanly
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

// Ensure tests use a workspace-based socket path rather than any pre-existing
// system socket (e.g. stale root-owned /run/assistant-ipc/assistant.sock).
delete process.env.ASSISTANT_IPC_SOCKET_DIR;

import { AssistantIpcServer } from "../assistant-server.js";
import { cliIpcCallStream } from "../cli-client.js";

// ---------------------------------------------------------------------------
// Fixture route
// ---------------------------------------------------------------------------

let _inferenceFixtureAborted = false;

const INFERENCE_SEND_FIXTURE_ROUTE = {
  operationId: "inference_send_fixture",
  endpoint: "/inference-send-fixture",
  method: "POST" as const,
  handler: async (params: Record<string, unknown> | undefined) => {
    _inferenceFixtureAborted = false;
    const signal = (params as { abortSignal?: AbortSignal })?.abortSignal;
    signal?.addEventListener(
      "abort",
      () => {
        _inferenceFixtureAborted = true;
      },
      { once: true },
    );
    const enc = new TextEncoder();
    return {
      stream: new ReadableStream<Uint8Array>({
        async start(ctrl) {
          const chunks = ["Hello", " world", "!"];
          for (const chunk of chunks) {
            if (signal?.aborted) {
              ctrl.error(new DOMException("Aborted", "AbortError"));
              return;
            }
            ctrl.enqueue(enc.encode(chunk));
            // Small delay between chunks to exercise async streaming
            await new Promise((r) => setTimeout(r, 10));
          }
          ctrl.close();
        },
      }),
      headers: { "content-type": "text/plain" },
    };
  },
};

// Fixture route that keeps the stream open until aborted
let inferenceAbortFixtureAborted = false;
const INFERENCE_ABORT_FIXTURE_ROUTE = {
  operationId: "inference_abort_fixture",
  endpoint: "/inference-abort-fixture",
  method: "POST" as const,
  handler: async (params: Record<string, unknown> | undefined) => {
    inferenceAbortFixtureAborted = false;
    const signal = (params as { abortSignal?: AbortSignal })?.abortSignal;
    return {
      stream: new ReadableStream<Uint8Array>({
        start(ctrl) {
          if (signal?.aborted) {
            inferenceAbortFixtureAborted = true;
            ctrl.error(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              inferenceAbortFixtureAborted = true;
              ctrl.error(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
          // Hold open until aborted — no close()
        },
      }),
      headers: {} as Record<string, string>,
    };
  },
};

mock.module("../../runtime/routes/index.js", () => ({
  ROUTES: [INFERENCE_SEND_FIXTURE_ROUTE, INFERENCE_ABORT_FIXTURE_ROUTE],
}));

// ---------------------------------------------------------------------------
// Setup / teardown
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
  _inferenceFixtureAborted = false;
  inferenceAbortFixtureAborted = false;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("inference_send IPC streaming smoke test", () => {
  test("resolves ok: true and has correct content-type header", async () => {
    await startServer();
    const r = await cliIpcCallStream("inference_send_fixture");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.headers["content-type"]).toBe("text/plain");
    // Drain the body
    const reader = r.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  });

  test("collects all chunks and accumulates to 'Hello world!'", async () => {
    await startServer();
    const r = await cliIpcCallStream("inference_send_fixture");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const chunks: string[] = [];
    const dec = new TextDecoder();
    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(dec.decode(value));
    }
    expect(chunks.join("")).toBe("Hello world!");
  });

  test("abort() cancels stream cleanly", async () => {
    await startServer();
    const r = await cliIpcCallStream("inference_abort_fixture");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const bodyReader = r.body.getReader();
    r.abort();

    // The stream should error after abort
    try {
      await bodyReader.read();
    } catch (err) {
      expect(err).toBeDefined();
    }

    // Give the server a tick to process the $cancel envelope
    await new Promise((res) => setTimeout(res, 200));
    expect(inferenceAbortFixtureAborted).toBe(true);
  });

  test("returns ok: false when no server is running", async () => {
    // Don't start a server — socket does not exist
    const r = await cliIpcCallStream("inference_send_fixture");
    expect(r.ok).toBe(false);
  });
});

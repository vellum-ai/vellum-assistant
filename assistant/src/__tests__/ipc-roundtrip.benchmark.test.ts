/**
 * IPC Serialization/Parsing Benchmark
 *
 * Measures serialize + parse round-trip performance in isolation
 * (no daemon required). Target ranges:
 * - Small message p95: < 1ms (averaged over 1000 runs)
 * - Large message (1MB): < 50ms
 * - Rapid-fire: no message loss across 100 messages
 * - Round-trip: content preserved exactly
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import type { ClientMessage, ServerMessage } from "../daemon/ipc-protocol.js";
import { createMessageParser, serialize } from "../daemon/ipc-protocol.js";

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

describe("IPC round-trip benchmark", () => {
  test("small message serialize + parse p95 < 1ms over 1000 runs", () => {
    const msg: ClientMessage = { type: "ping" };
    const parser = createMessageParser();
    const timings: number[] = [];

    for (let i = 0; i < 1000; i++) {
      const start = performance.now();
      const serialized = serialize(msg);
      const parsed = parser.feed(serialized);
      const elapsed = performance.now() - start;
      timings.push(elapsed);

      // Sanity: each iteration should yield exactly one message
      expect(parsed).toHaveLength(1);
    }

    const p95 = percentile(timings, 95);
    expect(p95).toBeLessThan(1);
  });

  test("large message (1MB) serialize + parse < 50ms", () => {
    // Build a ~1MB payload using assistant_text_delta with a large text field
    const largeText = "x".repeat(1024 * 1024);
    const msg: ServerMessage = {
      type: "assistant_text_delta",
      text: largeText,
    };
    const parser = createMessageParser();
    const timings: number[] = [];

    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      const serialized = serialize(msg);
      const parsed = parser.feed(serialized);
      const elapsed = performance.now() - start;
      timings.push(elapsed);

      expect(parsed).toHaveLength(1);
    }

    const p95 = percentile(timings, 95);
    expect(p95).toBeLessThan(50);
  });

  test("no message loss under rapid-fire (100 messages)", () => {
    const parser = createMessageParser();
    const messages: ClientMessage[] = [];

    for (let i = 0; i < 100; i++) {
      messages.push({ type: "session_list" } as ClientMessage);
    }

    // Serialize all messages and concatenate into a single buffer
    const combined = messages.map((m) => serialize(m)).join("");

    // Feed the entire buffer at once
    const parsed = parser.feed(combined);

    expect(parsed).toHaveLength(100);
    for (const p of parsed) {
      expect(p).toHaveProperty("type", "session_list");
    }
  });

  test("serialize + parse round-trip preserves message content", () => {
    const parser = createMessageParser();

    const clientMsg: ClientMessage = {
      type: "user_message",
      sessionId: "sess-abc-123",
      content:
        'Hello, world! Special chars: \u00e9\u00e0\u00fc \ud83d\ude00 "quotes" & <angle>',
      interface: "cli",
      attachments: [
        {
          filename: "test.txt",
          mimeType: "text/plain",
          data: "SGVsbG8gV29ybGQ=",
        },
      ],
    };

    const serialized = serialize(clientMsg);
    const parsed = parser.feed(serialized);

    expect(parsed).toHaveLength(1);
    const roundTripped = parsed[0] as ClientMessage;
    expect(roundTripped).toEqual(clientMsg);

    // Verify specific fields survived the round-trip
    expect(roundTripped.type).toBe("user_message");
    if (roundTripped.type === "user_message") {
      expect(roundTripped.sessionId).toBe("sess-abc-123");
      expect(roundTripped.content).toContain("\ud83d\ude00");
      expect(roundTripped.attachments).toHaveLength(1);
      expect(roundTripped.attachments![0].filename).toBe("test.txt");
    }
  });
});

describe("IPC Unix socket round-trip benchmark", () => {
  let server: net.Server;
  let client: net.Socket;
  let tmpDir: string;
  let socketPath: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-bench-"));
    socketPath = path.join(tmpDir, "bench.sock");

    // Server: parse incoming messages, echo back a session_list_response for each
    server = net.createServer((socket) => {
      const parser = createMessageParser();
      socket.on("data", (data) => {
        const msgs = parser.feed(data.toString());
        for (const _msg of msgs) {
          const response: ServerMessage = {
            type: "session_list_response",
            sessions: [],
          };
          socket.write(serialize(response));
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    client = net.createConnection(socketPath);
    await new Promise<void>((resolve) => client.on("connect", resolve));
  });

  afterAll(async () => {
    client?.destroy();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* server.close() may already remove it */
    }
    try {
      fs.rmdirSync(tmpDir);
    } catch {
      /* best-effort */
    }
  });

  test("session_list round-trip p50 < 5ms, p99 < 50ms", async () => {
    const clientParser = createMessageParser();
    const timings: number[] = [];
    const iterations = 50;

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();

      const responsePromise = new Promise<ServerMessage>((resolve) => {
        const handler = (data: Buffer) => {
          const msgs = clientParser.feed(data.toString());
          if (msgs.length > 0) {
            client.removeListener("data", handler);
            resolve(msgs[0] as ServerMessage);
          }
        };
        client.on("data", handler);
      });

      const request: ClientMessage = { type: "session_list" };
      client.write(serialize(request));

      const response = await responsePromise;
      const elapsed = performance.now() - start;
      timings.push(elapsed);

      expect(response.type).toBe("session_list_response");
    }

    const p50 = percentile(timings, 50);
    const p99 = percentile(timings, 99);
    expect(p50).toBeLessThan(5);
    expect(p99).toBeLessThan(50);
  });

  test("rapid-fire: 100 messages over socket without loss", async () => {
    const clientParser = createMessageParser();
    const messageCount = 100;
    const received: ServerMessage[] = [];

    const allReceived = new Promise<void>((resolve) => {
      const handler = (data: Buffer) => {
        const msgs = clientParser.feed(data.toString());
        for (const msg of msgs) {
          received.push(msg as ServerMessage);
        }
        if (received.length >= messageCount) {
          client.removeListener("data", handler);
          resolve();
        }
      };
      client.on("data", handler);
    });

    const start = performance.now();
    for (let i = 0; i < messageCount; i++) {
      const request: ClientMessage = { type: "session_list" };
      client.write(serialize(request));
    }

    await allReceived;
    const elapsed = performance.now() - start;

    expect(received).toHaveLength(messageCount);
    for (const msg of received) {
      expect(msg.type).toBe("session_list_response");
    }
    // All 100 messages should complete well within 100ms on a local socket
    expect(elapsed).toBeLessThan(100);
  });
});

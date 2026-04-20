/**
 * Integration-style unit tests for the native-messaging shim.
 *
 * Each test boots an ephemeral unix-socket server on a tmp path, runs
 * `runShim` with injected stdin/stdout streams, and asserts on the bytes
 * crossing both directions:
 *
 *   - Encoded Chrome frames pushed into stdin must arrive at the server as
 *     newline-delimited JSON.
 *   - Newline-delimited JSON written by the server must appear on stdout as
 *     valid length-prefixed Chrome frames.
 *   - A missing socket causes retry exhaustion → rejection.
 *   - A remote-close after a valid session resolves cleanly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import {
  createFrameReader,
  encodeFrame,
} from "../src/native-messaging/nmh-protocol.js";
import { runShim } from "../src/native-messaging/nmh-shim.js";

/** Build a fresh ephemeral socket path per test. */
function freshSocketPath(): string {
  const suffix = randomBytes(8).toString("hex");
  return join(tmpdir(), `nmh-test-${suffix}.sock`);
}

/** Start a unix-socket server that collects received bytes and exposes the first client. */
interface ServerHandle {
  server: Server;
  onClient: Promise<Socket>;
  received: Buffer[];
  stop: () => Promise<void>;
}

function startServer(socketPath: string): Promise<ServerHandle> {
  return new Promise((resolveHandle, rejectHandle) => {
    const received: Buffer[] = [];
    let resolveClient: (s: Socket) => void = () => {};
    const onClient = new Promise<Socket>((r) => {
      resolveClient = r;
    });
    const server = createServer((socket) => {
      socket.on("data", (chunk) => {
        received.push(Buffer.from(chunk));
      });
      resolveClient(socket);
    });
    server.on("error", (err) => rejectHandle(err));
    server.listen(socketPath, () => {
      resolveHandle({
        server,
        onClient,
        received,
        stop: () =>
          new Promise<void>((resolveStop) => {
            server.close(() => {
              try {
                unlinkSync(socketPath);
              } catch {
                // Socket file may already be cleaned up by the OS on close.
              }
              resolveStop();
            });
          }),
      });
    });
  });
}

/** Manually-pushable readable stream for fake stdin. */
class ManualReadable extends Readable {
  override _read(): void {
    // Data is pushed via `feed`/`finish` below.
  }
  feed(chunk: Buffer): void {
    this.push(chunk);
  }
  finish(): void {
    this.push(null);
  }
}

/** Writable that collects all written chunks for later assertions. */
class CollectingWritable extends Writable {
  chunks: Buffer[] = [];
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.chunks.push(buf);
    callback();
  }
  collected(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Concatenate all chunks recorded by the server. */
function concat(chunks: Buffer[]): Buffer {
  return Buffer.concat(chunks);
}

describe("nmh-shim", () => {
  let handle: ServerHandle | null = null;

  beforeEach(() => {
    handle = null;
  });

  afterEach(async () => {
    if (handle !== null) {
      await handle.stop();
      handle = null;
    }
  });

  test("relays encoded Chrome frames from stdin to the socket as newline-JSON", async () => {
    const socketPath = freshSocketPath();
    handle = await startServer(socketPath);

    const stdin = new ManualReadable();
    const stdout = new CollectingWritable();

    const shimDone = runShim({
      socketPath,
      stdin,
      stdout,
      connectRetries: 3,
      connectRetryDelayMs: 20,
    });
    shimDone.catch(() => {
      // Swallow — we assert on completion below and `stop()` causes a resolve.
    });

    // Wait for the server to see a connection.
    await handle.onClient;

    const frameA = encodeFrame({
      type: "join",
      meetingUrl: "https://meet",
      displayName: "Bot",
      consentMessage: "hi",
    });
    const frameB = encodeFrame({ type: "leave", reason: "done" });
    stdin.feed(Buffer.concat([frameA, frameB]));

    // Poll until both newline-JSON lines have arrived at the server.
    const deadline = Date.now() + 1000;
    let text = "";
    while (Date.now() < deadline) {
      text = concat(handle.received).toString("utf8");
      const lines = text.split("\n").filter((l) => l.length > 0);
      if (lines.length >= 2) break;
      await sleep(10);
    }
    const lines = text.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({
      type: "join",
      meetingUrl: "https://meet",
      displayName: "Bot",
      consentMessage: "hi",
    });
    expect(JSON.parse(lines[1]!)).toEqual({ type: "leave", reason: "done" });

    // Graceful shutdown.
    stdin.finish();
    await shimDone;
  });

  test("relays newline-JSON from the socket to stdout as encoded Chrome frames", async () => {
    const socketPath = freshSocketPath();
    handle = await startServer(socketPath);

    const stdin = new ManualReadable();
    const stdout = new CollectingWritable();

    const shimDone = runShim({
      socketPath,
      stdin,
      stdout,
      connectRetries: 3,
      connectRetryDelayMs: 20,
    });
    shimDone.catch(() => {
      // Swallow; asserted below.
    });

    const client = await handle.onClient;

    // Server writes two newline-JSON lines back to the shim.
    const payloadA = {
      type: "ready",
      extensionVersion: "1.0.0",
    };
    const payloadB = {
      type: "diagnostic",
      level: "info",
      message: "hi",
    };
    client.write(`${JSON.stringify(payloadA)}\n`);
    client.write(`${JSON.stringify(payloadB)}\n`);

    // Poll until stdout has two complete frames.
    const reader = createFrameReader();
    const collected: unknown[] = [];
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && collected.length < 2) {
      const buf = stdout.collected();
      if (buf.byteLength > 0) {
        // Reset reader by rebuilding — simplest; we always parse the
        // full accumulated output.
        const fresh = createFrameReader();
        const parsed = fresh.push(buf);
        collected.length = 0;
        collected.push(...parsed);
      }
      if (collected.length < 2) await sleep(10);
    }
    expect(collected).toHaveLength(2);
    expect(collected[0]).toEqual(payloadA);
    expect(collected[1]).toEqual(payloadB);

    // Silence the unused-reader lint.
    void reader;

    stdin.finish();
    await shimDone;
  });

  test("exits within a few hundred ms when the socket is not reachable", async () => {
    const socketPath = freshSocketPath(); // no server listening on this path
    const stdin = new ManualReadable();
    const stdout = new CollectingWritable();

    const start = Date.now();
    let caughtError: unknown = undefined;
    try {
      await runShim({
        socketPath,
        stdin,
        stdout,
        connectRetries: 2,
        connectRetryDelayMs: 30,
      });
    } catch (err) {
      caughtError = err;
    }
    const elapsed = Date.now() - start;

    expect(caughtError).toBeInstanceOf(Error);
    expect(String((caughtError as Error).message)).toMatch(
      /could not connect/i,
    );
    // 2 retries * 30ms delay + tcp/connect overhead — generous upper bound.
    expect(elapsed).toBeLessThan(1500);
  });

  test("preserves multibyte UTF-8 split across socket chunk boundaries", async () => {
    const socketPath = freshSocketPath();
    handle = await startServer(socketPath);

    const stdin = new ManualReadable();
    const stdout = new CollectingWritable();

    const shimDone = runShim({
      socketPath,
      stdin,
      stdout,
      connectRetries: 3,
      connectRetryDelayMs: 20,
    });
    shimDone.catch(() => {
      // Swallow; asserted by stdout shape below.
    });

    const client = await handle.onClient;

    // Build a payload whose JSON encoding contains characters that span
    // multiple UTF-8 bytes (here: an emoji that requires a 4-byte sequence
    // and CJK characters that require 3 bytes). Splitting the byte stream
    // mid-codepoint would corrupt this if the shim decoded chunks
    // independently.
    const message = "héllo 🌍 世界";
    const payload = { type: "diagnostic", level: "info", message };
    const lineBytes = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");

    // Split such that at least one multibyte codepoint straddles the seam.
    const splitAt = lineBytes.indexOf(0xf0); // first byte of the 4-byte 🌍
    expect(splitAt).toBeGreaterThan(0);
    client.write(lineBytes.subarray(0, splitAt + 1));
    await sleep(20);
    client.write(lineBytes.subarray(splitAt + 1));

    const deadline = Date.now() + 1000;
    let collected: unknown[] = [];
    while (Date.now() < deadline && collected.length < 1) {
      const buf = stdout.collected();
      if (buf.byteLength > 0) {
        collected = createFrameReader().push(buf);
      }
      if (collected.length < 1) await sleep(10);
    }

    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual(payload);

    stdin.finish();
    await shimDone;
  });

  test("settles cleanly on socket close without leaking stdin listeners", async () => {
    const socketPath = freshSocketPath();
    handle = await startServer(socketPath);

    const stdin = new ManualReadable();
    const stdout = new CollectingWritable();

    const before = stdin.listenerCount("data");

    const shimDone = runShim({
      socketPath,
      stdin,
      stdout,
      connectRetries: 3,
      connectRetryDelayMs: 20,
    });

    const client = await handle.onClient;
    // Give the shim a tick to finish wiring listeners after its connect
    // callback resolves on this side.
    await sleep(10);
    expect(stdin.listenerCount("data")).toBeGreaterThan(before);
    expect(stdin.listenerCount("end")).toBeGreaterThan(0);
    expect(stdin.listenerCount("error")).toBeGreaterThan(0);

    // Server closes — runShim should resolve and detach every stdin
    // listener it attached, so the host process's event loop isn't
    // pinned alive by the shim's references.
    client.end();
    await shimDone;

    expect(stdin.listenerCount("data")).toBe(before);
    expect(stdin.listenerCount("end")).toBe(0);
    expect(stdin.listenerCount("error")).toBe(0);
  });

  test("resolves cleanly when the server closes the connection", async () => {
    const socketPath = freshSocketPath();
    handle = await startServer(socketPath);

    const stdin = new ManualReadable();
    const stdout = new CollectingWritable();

    const shimDone = runShim({
      socketPath,
      stdin,
      stdout,
      connectRetries: 3,
      connectRetryDelayMs: 20,
    });

    const client = await handle.onClient;
    // Close the server-side socket cleanly.
    client.end();

    // `runShim` should resolve — not reject — on remote close.
    await shimDone;
  });
});

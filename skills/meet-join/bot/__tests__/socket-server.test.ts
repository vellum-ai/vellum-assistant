/**
 * Unit tests for the Chrome native-messaging Unix-socket server.
 *
 * These tests open real unix sockets in the OS temp directory (no TCP, no
 * external services) and simulate the native-messaging shim with a plain
 * `net.createConnection` client. The goal is to exercise the full pump —
 * framing, schema validation, cutover semantics, shutdown cleanup — without
 * mocking away the transport.
 *
 * Coverage:
 *   - Handshake: `{type:"ready"}` from the client resolves `waitForReady`.
 *   - Inbound dispatch: a valid lifecycle frame reaches `onExtensionMessage`.
 *   - Outbound: `sendToExtension` writes a newline-terminated JSON line.
 *   - Drop paths: wrong-schema and malformed JSON warn but keep the server alive.
 *   - Cutover: a second client connect displaces the first.
 *   - Shutdown: `stop()` unlinks the socket file.
 *   - Timeout: `waitForReady` rejects past its deadline.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createConnection, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createNmhSocketServer,
  type NmhSocketLogger,
  type NmhSocketServer,
} from "../src/native-messaging/socket-server.js";
import type {
  BotToExtensionMessage,
  ExtensionToBotMessage,
} from "../../contracts/native-messaging.js";

/** -------------------- helpers --------------------------------------- */

/**
 * Build a fresh unique socket path under `tmpdir()`. Every test calls this
 * so concurrent test runs can't stomp on each other's socket files.
 */
function freshSocketPath(): string {
  const rnd = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `socket-server-test-${rnd}-${process.pid}.sock`);
}

/**
 * Capture logger — records every info/warn line for post-hoc assertions.
 */
interface CapturingLogger extends NmhSocketLogger {
  infoMessages: string[];
  warnMessages: string[];
}
function captureLogger(): CapturingLogger {
  const info: string[] = [];
  const warn: string[] = [];
  return {
    infoMessages: info,
    warnMessages: warn,
    info: (m) => info.push(m),
    warn: (m) => warn.push(m),
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `predicate` until true or the deadline elapses. Test utility to
 * avoid fragile fixed sleeps on async side-effects.
 */
async function waitFor(
  predicate: () => boolean,
  {
    timeoutMs = 2000,
    intervalMs = 5,
  }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor: predicate did not become true in ${timeoutMs}ms`);
}

/**
 * Connect a client to the server at `path` and resolve once the connection
 * is established. The returned socket has `setEncoding("utf8")` so data
 * events deliver strings directly.
 */
async function connectClient(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ path });
    const onError = (err: Error): void => {
      sock.off("connect", onConnect);
      reject(err);
    };
    const onConnect = (): void => {
      sock.off("error", onError);
      sock.setEncoding("utf8");
      resolve(sock);
    };
    sock.once("error", onError);
    sock.once("connect", onConnect);
  });
}

/**
 * Write a JSON value followed by a newline. Matches the framing the server
 * expects from the real shim.
 */
function writeJsonLine(sock: Socket, value: unknown): void {
  sock.write(`${JSON.stringify(value)}\n`);
}

/** Registry of servers/clients so tests can be torn down deterministically. */
interface TestFixtures {
  server?: NmhSocketServer;
  clients: Socket[];
}

const active: TestFixtures = { clients: [] };

afterEach(async () => {
  for (const c of active.clients) {
    try {
      c.destroy();
    } catch {
      // Best-effort.
    }
  }
  active.clients = [];
  if (active.server) {
    try {
      await active.server.stop();
    } catch {
      // Best-effort.
    }
    active.server = undefined;
  }
});

function track<T extends NmhSocketServer>(srv: T): T {
  active.server = srv;
  return srv;
}
function trackClient(c: Socket): Socket {
  active.clients.push(c);
  return c;
}

/** -------------------- tests ----------------------------------------- */

describe("createNmhSocketServer — handshake", () => {
  test("resolves waitForReady after the client sends a ready frame", async () => {
    const logger = captureLogger();
    const path = freshSocketPath();
    const server = track(createNmhSocketServer({ socketPath: path, logger }));
    await server.start();

    const client = trackClient(await connectClient(path));
    const readyPromise = server.waitForReady(2000);

    const ready: ExtensionToBotMessage = {
      type: "ready",
      extensionVersion: "1.0.0",
    };
    writeJsonLine(client, ready);

    await readyPromise;
    // Idempotent: a second call should resolve immediately.
    await server.waitForReady(10);
  });
});

describe("createNmhSocketServer — inbound dispatch", () => {
  test("fires onExtensionMessage for a valid lifecycle frame", async () => {
    const logger = captureLogger();
    const path = freshSocketPath();
    const server = track(createNmhSocketServer({ socketPath: path, logger }));
    await server.start();

    const received: ExtensionToBotMessage[] = [];
    server.onExtensionMessage((m) => received.push(m));

    const client = trackClient(await connectClient(path));
    const lifecycle: ExtensionToBotMessage = {
      type: "lifecycle",
      state: "joining",
      meetingId: "m-abc",
      timestamp: new Date().toISOString(),
    };
    writeJsonLine(client, lifecycle);

    await waitFor(() => received.length === 1);
    const msg = received[0]!;
    expect(msg.type).toBe("lifecycle");
    if (msg.type === "lifecycle") {
      expect(msg.state).toBe("joining");
      expect(msg.meetingId).toBe("m-abc");
    }
  });

  test("supports multiple onExtensionMessage listeners (fan-out)", async () => {
    const logger = captureLogger();
    const path = freshSocketPath();
    const server = track(createNmhSocketServer({ socketPath: path, logger }));
    await server.start();

    const a: ExtensionToBotMessage[] = [];
    const b: ExtensionToBotMessage[] = [];
    server.onExtensionMessage((m) => a.push(m));
    server.onExtensionMessage((m) => b.push(m));

    const client = trackClient(await connectClient(path));
    writeJsonLine(client, {
      type: "ready",
      extensionVersion: "1.0.0",
    } satisfies ExtensionToBotMessage);

    await waitFor(() => a.length === 1 && b.length === 1);
  });

  test("handles multiple frames delivered in a single TCP chunk", async () => {
    const logger = captureLogger();
    const path = freshSocketPath();
    const server = track(createNmhSocketServer({ socketPath: path, logger }));
    await server.start();

    const received: ExtensionToBotMessage[] = [];
    server.onExtensionMessage((m) => received.push(m));

    const client = trackClient(await connectClient(path));
    // Two frames concatenated in a single write — the server must split on
    // `\n` rather than treating the blob as a single JSON document.
    const first = {
      type: "ready",
      extensionVersion: "1.0.0",
    } satisfies ExtensionToBotMessage;
    const second = {
      type: "lifecycle",
      state: "joined",
      meetingId: "m-xyz",
      timestamp: new Date().toISOString(),
    } satisfies ExtensionToBotMessage;
    client.write(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);

    await waitFor(() => received.length === 2);
    expect(received[0]!.type).toBe("ready");
    expect(received[1]!.type).toBe("lifecycle");
  });
});

describe("createNmhSocketServer — outbound", () => {
  test("sendToExtension writes a newline-terminated JSON line", async () => {
    const logger = captureLogger();
    const path = freshSocketPath();
    const server = track(createNmhSocketServer({ socketPath: path, logger }));
    await server.start();

    const client = trackClient(await connectClient(path));

    // Accumulate whatever the client receives from the server.
    let clientRecv = "";
    client.on("data", (chunk) => {
      clientRecv += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    // Wait a tick so the server sees the accept before we try to send.
    await sleep(20);

    const join: BotToExtensionMessage = {
      type: "join",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      displayName: "Bot",
      consentMessage: "Recording for the user.",
    };
    server.sendToExtension(join);

    await waitFor(() => clientRecv.includes("\n"));
    // The payload must end in exactly one newline.
    expect(clientRecv.endsWith("\n")).toBe(true);
    const line = clientRecv.slice(0, -1);
    const parsed = JSON.parse(line);
    expect(parsed).toEqual(join);
  });

  test("sendToExtension throws when no client is connected", async () => {
    const logger = captureLogger();
    const path = freshSocketPath();
    const server = track(createNmhSocketServer({ socketPath: path, logger }));
    await server.start();

    expect(() =>
      server.sendToExtension({
        type: "leave",
        reason: "test",
      }),
    ).toThrow(/no extension client connected/);
  });
});

describe("createNmhSocketServer — defensive parsing", () => {
  test("drops schema-invalid JSON and keeps serving", async () => {
    const logger = captureLogger();
    const path = freshSocketPath();
    const server = track(createNmhSocketServer({ socketPath: path, logger }));
    await server.start();

    const received: ExtensionToBotMessage[] = [];
    server.onExtensionMessage((m) => received.push(m));

    const client = trackClient(await connectClient(path));
    // Well-formed JSON, wrong schema — the `type` is not a valid discriminator.
    client.write(`${JSON.stringify({ type: "nope", extraneous: 1 })}\n`);
    // Then a valid ready frame to prove the server is still processing input.
    writeJsonLine(client, {
      type: "ready",
      extensionVersion: "1.0.0",
    } satisfies ExtensionToBotMessage);

    await waitFor(() => received.length === 1);
    expect(received[0]!.type).toBe("ready");
    expect(logger.warnMessages.some((m) => m.includes("schema-invalid"))).toBe(
      true,
    );
  });

  test("drops malformed JSON and keeps serving", async () => {
    const logger = captureLogger();
    const path = freshSocketPath();
    const server = track(createNmhSocketServer({ socketPath: path, logger }));
    await server.start();

    const received: ExtensionToBotMessage[] = [];
    server.onExtensionMessage((m) => received.push(m));

    const client = trackClient(await connectClient(path));
    client.write("not-json\n");
    writeJsonLine(client, {
      type: "ready",
      extensionVersion: "1.0.0",
    } satisfies ExtensionToBotMessage);

    await waitFor(() => received.length === 1);
    expect(received[0]!.type).toBe("ready");
    expect(logger.warnMessages.some((m) => m.includes("malformed JSON"))).toBe(
      true,
    );
  });
});

describe("createNmhSocketServer — cutover", () => {
  test("second client connect displaces the first and the server keeps serving", async () => {
    const logger = captureLogger();
    const path = freshSocketPath();
    const server = track(createNmhSocketServer({ socketPath: path, logger }));
    await server.start();

    const received: ExtensionToBotMessage[] = [];
    server.onExtensionMessage((m) => received.push(m));

    // First client connects and sends a ready frame.
    const first = trackClient(await connectClient(path));
    let firstClosed = false;
    first.on("close", () => {
      firstClosed = true;
    });
    writeJsonLine(first, {
      type: "ready",
      extensionVersion: "1.0.0",
    } satisfies ExtensionToBotMessage);
    await waitFor(() => received.length === 1);

    // Second client connects — the server must accept it and close the first.
    const second = trackClient(await connectClient(path));
    await waitFor(() => firstClosed === true);
    expect(
      logger.warnMessages.some((m) => m.includes("closing previous client")),
    ).toBe(true);

    // Verify the second client is now the active one by sending from it
    // and observing dispatch.
    writeJsonLine(second, {
      type: "lifecycle",
      state: "joined",
      meetingId: "m-new",
      timestamp: new Date().toISOString(),
    } satisfies ExtensionToBotMessage);

    await waitFor(() => received.length === 2);
    expect(received[1]!.type).toBe("lifecycle");
  });
});

describe("createNmhSocketServer — shutdown", () => {
  test("stop() unlinks the socket file and subsequent sendToExtension throws", async () => {
    const logger = captureLogger();
    const path = freshSocketPath();
    const server = track(createNmhSocketServer({ socketPath: path, logger }));
    await server.start();

    // Connect a client, then stop — the socket file must be gone afterwards.
    trackClient(await connectClient(path));
    await sleep(20);
    expect(existsSync(path)).toBe(true);

    await server.stop();
    // Clear the registry so the afterEach hook doesn't try to stop again.
    active.server = undefined;

    expect(existsSync(path)).toBe(false);

    // After stop, no client is connected, so sendToExtension throws.
    expect(() =>
      server.sendToExtension({ type: "leave", reason: "post-stop" }),
    ).toThrow(/no extension client connected/);
  });

  test("stop() is idempotent", async () => {
    const logger = captureLogger();
    const path = freshSocketPath();
    const server = track(createNmhSocketServer({ socketPath: path, logger }));
    await server.start();

    await server.stop();
    // A second stop() must not throw.
    await server.stop();
    active.server = undefined;
  });
});

describe("createNmhSocketServer — cutover resets handshake", () => {
  test("waitForReady after a reconnect waits for the new client's ready frame", async () => {
    const logger = captureLogger();
    const path = freshSocketPath();
    const server = track(createNmhSocketServer({ socketPath: path, logger }));
    await server.start();

    // First client connects and completes the handshake.
    const first = trackClient(await connectClient(path));
    writeJsonLine(first, {
      type: "ready",
      extensionVersion: "1.0.0",
    } satisfies ExtensionToBotMessage);
    await server.waitForReady(2000);

    // Second client connects — the cutover must invalidate the sticky ready
    // flag so a fresh `waitForReady` blocks on the new handshake rather than
    // resolving immediately against the previous client's state.
    const second = trackClient(await connectClient(path));
    // Give the server a tick to accept the second connection before we
    // inspect its post-cutover handshake state.
    await sleep(20);

    let resolved = false;
    const pending = server.waitForReady(2000).then(() => {
      resolved = true;
    });
    await sleep(30);
    expect(resolved).toBe(false);

    writeJsonLine(second, {
      type: "ready",
      extensionVersion: "1.0.0",
    } satisfies ExtensionToBotMessage);
    await pending;
    expect(resolved).toBe(true);
  });
});

describe("createNmhSocketServer — start failure recovery", () => {
  test("a failed start() leaves the server retryable rather than silently no-op", async () => {
    const logger = captureLogger();
    // Start with a non-existent parent directory — listen() on a Unix socket
    // whose parent does not exist fails with ENOENT. If `started=true` were
    // set before listen() resolved, the retry below would silently no-op and
    // never bind even after the directory is created.
    const badPath = join(
      tmpdir(),
      `socket-server-bad-${Math.random().toString(36).slice(2, 10)}`,
      "nested",
      "x.sock",
    );

    const server = createNmhSocketServer({ socketPath: badPath, logger });
    let firstErr: unknown;
    try {
      await server.start();
    } catch (err) {
      firstErr = err;
    }
    expect(firstErr).toBeInstanceOf(Error);

    // Swap in a valid path and retry. The retry must actually bind.
    const goodPath = freshSocketPath();
    const retry = track(
      createNmhSocketServer({ socketPath: goodPath, logger }),
    );
    await retry.start();
    expect(existsSync(goodPath)).toBe(true);
  });
});

describe("createNmhSocketServer — waitForReady timeout", () => {
  test("rejects when no ready frame arrives within the budget", async () => {
    const logger = captureLogger();
    const path = freshSocketPath();
    const server = track(createNmhSocketServer({ socketPath: path, logger }));
    await server.start();

    // Connect a client but never send ready.
    trackClient(await connectClient(path));

    let thrown: unknown;
    try {
      await server.waitForReady(40);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("timed out");
  });
});

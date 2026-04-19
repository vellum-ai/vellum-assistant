#!/usr/bin/env bun
/**
 * Native-messaging host shim — stdio <-> unix-socket bridge.
 *
 * Chrome spawns its configured "native-messaging host" binary and talks to it
 * over that child's stdio using a length-prefixed JSON wire format (see
 * `nmh-protocol.ts`). Our bot process, however, lives in a separate container
 * and listens on a unix-domain socket. This shim is the small bridging process
 * Chrome actually launches: it reads framed stdio from Chrome, relays each
 * payload as newline-delimited JSON to the bot socket, and writes framed
 * responses back to Chrome's stdio.
 *
 * The shim is intentionally dumb — just a format translator. Payload validation
 * (via the zod schemas in `skills/meet-join/contracts/native-messaging.ts`)
 * happens at the bot-socket-server layer added in PR 7, not here. Keeping the
 * shim schema-unaware means the bot can evolve the message shapes without a
 * coordinated redeploy of the in-Chromium shim binary.
 *
 * Lifecycle:
 *   - Connect to the configured unix socket, retrying with a short backoff.
 *   - Proxy stdin frames → socket newline-JSON.
 *   - Proxy socket newline-JSON → stdout frames.
 *   - Resolve cleanly on stdin EOF or remote socket close.
 *   - Exit 1 on connect-retry exhaustion or unparseable stdin.
 *
 * Errors are logged to stderr, which Chrome captures and writes to its native-
 * messaging diagnostic log — so operators can see what went wrong even when
 * the parent Chrome process is the one that spawned us.
 */

import { connect, type Socket } from "node:net";

import { createFrameReader, encodeFrame } from "./nmh-protocol.js";

/**
 * Options accepted by `runShim`. Everything is injectable for tests; the
 * production entrypoint at the bottom of this file wires stdin/stdout and
 * reads `NMH_SOCKET_PATH` from the environment.
 */
export interface RunShimOptions {
  /** Filesystem path of the unix socket to connect to. */
  socketPath: string;
  /** Stream the shim reads framed Chrome messages from. Defaults to `process.stdin`. */
  stdin?: NodeJS.ReadableStream;
  /** Stream the shim writes framed Chrome responses to. Defaults to `process.stdout`. */
  stdout?: NodeJS.WritableStream;
  /** Max connection attempts before giving up (inclusive of the first try). Default 5. */
  connectRetries?: number;
  /** Delay in ms between connection attempts. Default 200. */
  connectRetryDelayMs?: number;
}

const DEFAULT_CONNECT_RETRIES = 5;
const DEFAULT_CONNECT_RETRY_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempt a single unix-socket connection. Resolves with the connected socket
 * or rejects with the connect error — no retries here, callers wrap this.
 */
function connectOnce(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    const onConnect = (): void => {
      socket.off("error", onError);
      resolve(socket);
    };
    const onError = (err: Error): void => {
      socket.off("connect", onConnect);
      socket.destroy();
      reject(err);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

/**
 * Connect to `socketPath` with a simple retry loop. Throws a descriptive
 * error after the final attempt fails so the shim can exit 1 with useful
 * diagnostics on stderr.
 */
async function connectWithRetries(
  socketPath: string,
  retries: number,
  retryDelayMs: number,
): Promise<Socket> {
  let lastError: unknown = undefined;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await connectOnce(socketPath);
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(retryDelayMs);
      }
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `could not connect to native-messaging socket at ${socketPath} after ${retries} attempt(s): ${reason}`,
  );
}

/**
 * Run the native-messaging shim until either side closes. Resolves cleanly on
 * stdin EOF or remote socket close. Rejects on connect-retry exhaustion or on
 * a malformed inbound frame from Chrome.
 */
export async function runShim(opts: RunShimOptions): Promise<void> {
  // Narrow the defaults to the structural NodeJS interfaces — the
  // `process.stdin` type includes tty-specific overloads that conflict with
  // the public `NodeJS.ReadableStream` overload set and cause the
  // event-listener calls below to fail type inference.
  const stdin: NodeJS.ReadableStream = opts.stdin ?? process.stdin;
  const stdout: NodeJS.WritableStream = opts.stdout ?? process.stdout;
  const retries = opts.connectRetries ?? DEFAULT_CONNECT_RETRIES;
  const retryDelayMs = opts.connectRetryDelayMs ?? DEFAULT_CONNECT_RETRY_DELAY_MS;

  const socket = await connectWithRetries(opts.socketPath, retries, retryDelayMs);

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      try {
        socket.end();
      } catch {
        // socket may already be torn down — nothing actionable.
      }
      if (err) reject(err);
      else resolve();
    };

    // ----------------------- Chrome stdin → socket -----------------------
    const frameReader = createFrameReader();
    stdin.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      let frames: unknown[];
      try {
        frames = frameReader.push(buf);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`nmh-shim: failed to parse Chrome frame: ${msg}\n`);
        settle(err instanceof Error ? err : new Error(msg));
        return;
      }
      for (const frame of frames) {
        const line = `${JSON.stringify(frame)}\n`;
        socket.write(line);
      }
    });
    stdin.on("end", () => {
      // Chrome closed its side: drain the socket and resolve cleanly.
      settle();
    });
    stdin.on("error", (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`nmh-shim: stdin error: ${msg}\n`);
      settle(err instanceof Error ? err : new Error(msg));
    });

    // ----------------------- socket → Chrome stdout -----------------------
    let socketBuffer = "";
    socket.on("data", (chunk: Buffer) => {
      socketBuffer += chunk.toString("utf8");
      // Drain complete newline-delimited JSON objects. The remainder (after
      // the last newline) stays in the buffer for the next read.
      let newlineIdx = socketBuffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = socketBuffer.slice(0, newlineIdx);
        socketBuffer = socketBuffer.slice(newlineIdx + 1);
        if (line.length > 0) {
          try {
            const parsed: unknown = JSON.parse(line);
            const frame = encodeFrame(parsed);
            stdout.write(frame);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `nmh-shim: failed to encode bot→extension frame: ${msg}\n`,
            );
          }
        }
        newlineIdx = socketBuffer.indexOf("\n");
      }
    });
    socket.on("error", (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`nmh-shim: socket error: ${msg}\n`);
      settle(err instanceof Error ? err : new Error(msg));
    });
    socket.on("close", () => {
      // Remote end closed: graceful exit.
      settle();
    });
  });
}

// -------------------------------------------------------------------------
// Entrypoint guard — executed only when this file is the process entry.
// -------------------------------------------------------------------------
if (import.meta.main) {
  const socketPath = process.env.NMH_SOCKET_PATH ?? "/run/nmh.sock";
  runShim({ socketPath }).catch((err) => {
    process.stderr.write(
      `nmh-shim: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}

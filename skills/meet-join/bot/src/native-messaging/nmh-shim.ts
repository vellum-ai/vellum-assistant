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
import { StringDecoder } from "node:string_decoder";

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

/**
 * Hard cap on the socket→stdout decode buffer. Mirrors the per-frame ceiling
 * the protocol layer enforces: a single bot→Chrome message can't legitimately
 * exceed `MAX_FRAME_SIZE`, so a buffer that grows past 2× without yielding a
 * complete newline-terminated line means the upstream is malformed (no
 * newlines, oversized line) and we abort rather than grow unbounded.
 */
const MAX_SOCKET_BUFFER_BYTES = 2_000_000;

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
  const reason =
    lastError instanceof Error ? lastError.message : String(lastError);
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
  const retryDelayMs =
    opts.connectRetryDelayMs ?? DEFAULT_CONNECT_RETRY_DELAY_MS;

  const socket = await connectWithRetries(
    opts.socketPath,
    retries,
    retryDelayMs,
  );

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    // Named handlers so `settle()` can detach them. Without detach, the shim
    // process would keep the event loop alive after socket close (hanging on
    // exit) and any later writes from a still-open stdin would silently land
    // on a destroyed socket.
    const onStdinData = (chunk: Buffer | string): void => {
      const buf =
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      let frames: unknown[];
      try {
        frames = frameReader.push(buf);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `nmh-shim: failed to parse Chrome frame: ${msg}\n`,
        );
        // Frame-reader buffer is in an indeterminate state after a length /
        // JSON parse failure — we can't resync, so tear down. (The socket
        // direction below is newline-delimited and CAN resync at the next
        // newline, which is why that path only logs.)
        settle(err instanceof Error ? err : new Error(msg));
        return;
      }
      for (const frame of frames) {
        const line = `${JSON.stringify(frame)}\n`;
        socket.write(line);
      }
    };
    const onStdinEnd = (): void => {
      // Chrome closed its side: drain the socket and resolve cleanly.
      settle();
    };
    const onStdinError = (err: unknown): void => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`nmh-shim: stdin error: ${msg}\n`);
      settle(err instanceof Error ? err : new Error(msg));
    };
    const onSocketData = (chunk: Buffer): void => {
      // Decode incrementally so a multibyte UTF-8 codepoint split across
      // chunk boundaries is reassembled instead of corrupted into U+FFFDs.
      socketBuffer += socketDecoder.write(chunk);
      if (socketBuffer.length > MAX_SOCKET_BUFFER_BYTES) {
        const err = new Error(
          `nmh-shim: socket buffer exceeded ${MAX_SOCKET_BUFFER_BYTES} bytes without a newline`,
        );
        process.stderr.write(`${err.message}\n`);
        settle(err);
        return;
      }
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
            // Newline-delimited stream — drop the bad line and resync at the
            // next newline rather than tearing the shim down.
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `nmh-shim: failed to encode bot→extension frame: ${msg}\n`,
            );
          }
        }
        newlineIdx = socketBuffer.indexOf("\n");
      }
    };
    const onSocketError = (err: unknown): void => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`nmh-shim: socket error: ${msg}\n`);
      settle(err instanceof Error ? err : new Error(msg));
    };
    const onSocketClose = (): void => {
      // Remote end closed: graceful exit.
      settle();
    };

    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      // Detach every listener we attached so the event loop can exit and so
      // late-arriving stdin chunks don't try to write to a torn-down socket.
      stdin.off("data", onStdinData);
      stdin.off("end", onStdinEnd);
      stdin.off("error", onStdinError);
      socket.off("data", onSocketData);
      socket.off("error", onSocketError);
      socket.off("close", onSocketClose);
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
    stdin.on("data", onStdinData);
    stdin.on("end", onStdinEnd);
    stdin.on("error", onStdinError);

    // ----------------------- socket → Chrome stdout -----------------------
    const socketDecoder = new StringDecoder("utf8");
    let socketBuffer = "";
    socket.on("data", onSocketData);
    socket.on("error", onSocketError);
    socket.on("close", onSocketClose);
  });
}

// -------------------------------------------------------------------------
// Entrypoint guard — executed only when this file is the process entry.
// -------------------------------------------------------------------------
if (import.meta.main) {
  const socketPath = process.env.NMH_SOCKET_PATH ?? "/run/nmh.sock";
  runShim({ socketPath })
    .then(() => {
      // Force exit on success so the process terminates even if some stdio
      // handle still has a ref keeping the event loop alive.
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(
        `nmh-shim: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}

/**
 * Unix-socket server that carries the Chrome Native Messaging bridge between
 * the meet-bot process and its in-browser extension.
 *
 * Chrome can't talk to a long-lived bot process directly from an extension,
 * so we run a small **native-messaging shim** (a separate stdio host Chrome
 * launches) that forwards Chrome's length-prefixed frames over this Unix
 * socket. From the bot's perspective the transport is plain newline-delimited
 * JSON: each `\n`-terminated line is a single message, validated against the
 * {@link ExtensionToBotMessageSchema} / {@link BotToExtensionMessageSchema}
 * pair from {@link ../../../contracts/native-messaging.js}.
 *
 * Design notes:
 *
 * - **Single-client policy.** Chrome restarts (or the shim reconnecting after
 *   a browser crash) must not wedge the server. When a new client connects
 *   while one is already active, we log a warning, close the old one, and
 *   accept the new connection. The bot's view of "the extension" is
 *   always "the most recent connection".
 * - **Newline framing.** Both directions use JSON lines. We maintain a
 *   per-connection buffer and split on `\n` on each `data` event so that
 *   TCP-style coalesced frames are handled correctly.
 * - **Defensive parsing.** Malformed JSON or schema-invalid payloads are
 *   logged via `logger.warn` and dropped; the server must never crash on
 *   bad input. The shim is untrusted in the sense that extension bugs
 *   shouldn't be able to take down the bot.
 * - **Outbound validation.** `sendToExtension` re-validates every frame so
 *   a caller can't smuggle an invalid shape past the wire — catching the
 *   bug at the source instead of on the extension side.
 * - **Ready handshake.** The extension sends `{ type: "ready" }` once its
 *   background service worker is up. Callers await `waitForReady` before
 *   issuing the first `join` command so commands don't get dropped while
 *   the shim is still negotiating.
 */

import { createServer, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";

import {
  BotToExtensionMessageSchema,
  ExtensionToBotMessageSchema,
  type BotToExtensionMessage,
  type ExtensionToBotMessage,
} from "../../../contracts/native-messaging.js";

/** Minimal logger surface the server needs. */
export interface NmhSocketLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

export interface NmhSocketServerOptions {
  /** Filesystem path of the Unix-domain socket to listen on. */
  socketPath: string;
  /** Logger for diagnostics (ignored for malformed payloads — we just drop). */
  logger: NmhSocketLogger;
}

export interface NmhSocketServer {
  /**
   * Unlink any stale socket file at `socketPath` and begin listening. Resolves
   * once the `net.Server` has bound.
   */
  start(): Promise<void>;
  /**
   * Stop the listener, close any active client, and unlink the socket file.
   * Idempotent — safe to call multiple times.
   */
  stop(): Promise<void>;
  /**
   * Send a command to the extension. Throws synchronously if no client is
   * connected or if the payload fails schema validation.
   */
  sendToExtension(msg: BotToExtensionMessage): void;
  /**
   * Register a callback fired for every valid inbound message. Multiple
   * callbacks are supported (fan-out).
   */
  onExtensionMessage(cb: (msg: ExtensionToBotMessage) => void): void;
  /**
   * Resolve once the first `{ type: "ready" }` frame has been received.
   * Rejects if `timeoutMs` elapses first. Idempotent: if the handshake has
   * already been seen the returned promise resolves immediately.
   */
  waitForReady(timeoutMs: number): Promise<void>;
}

/**
 * Create (but do not start) the Unix-socket server. Call `start()` to bind.
 */
export function createNmhSocketServer(
  opts: NmhSocketServerOptions,
): NmhSocketServer {
  const { socketPath, logger } = opts;

  /** Registered inbound listeners (fan-out). */
  const listeners: Array<(msg: ExtensionToBotMessage) => void> = [];

  /** The currently active connection, if any. */
  let activeSocket: Socket | null = null;
  /** Per-connection buffer for partial lines. Reset on every new connection. */
  let inboundBuffer = "";

  let server: Server | null = null;
  let started = false;
  let stopped = false;

  /** True once the first `{type:"ready"}` frame has been received. */
  let ready = false;
  /** Waiters created before the handshake lands. */
  const readyWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  /**
   * Flush every queued `waitForReady` waiter with the handshake result. On
   * success we resolve each waiter; on server teardown we reject them so
   * callers don't hang forever.
   */
  function flushReadyWaiters(err?: Error): void {
    while (readyWaiters.length > 0) {
      const w = readyWaiters.shift()!;
      clearTimeout(w.timer);
      if (err) {
        w.reject(err);
      } else {
        w.resolve();
      }
    }
  }

  /**
   * Handle a single parsed-and-validated inbound message: mark the handshake
   * as complete on `ready`, then fan out to every registered listener.
   */
  function dispatchInbound(msg: ExtensionToBotMessage): void {
    if (msg.type === "ready" && !ready) {
      ready = true;
      flushReadyWaiters();
    }
    for (const cb of listeners) {
      try {
        cb(msg);
      } catch (err) {
        // A listener throwing shouldn't take down the socket pump. Log and
        // keep going so the remaining callbacks still fire.
        logger.warn(
          `nmh-socket-server: listener threw for message type=${msg.type}: ${formatError(err)}`,
        );
      }
    }
  }

  /**
   * Consume a newly-arrived chunk of bytes: split on `\n`, parse each line
   * as JSON, validate with the extension→bot schema, and dispatch. Malformed
   * JSON and schema-invalid payloads warn and drop.
   */
  function handleData(chunk: Buffer | string): void {
    inboundBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newlineIdx = inboundBuffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = inboundBuffer.slice(0, newlineIdx);
      inboundBuffer = inboundBuffer.slice(newlineIdx + 1);
      newlineIdx = inboundBuffer.indexOf("\n");
      // Tolerate the `\r\n` form in case a producer is careless about line
      // endings — strip the trailing CR rather than failing to parse.
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (trimmed.length === 0) continue;

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(trimmed);
      } catch (err) {
        logger.warn(
          `nmh-socket-server: dropping malformed JSON frame: ${formatError(err)}`,
        );
        continue;
      }

      const validated = ExtensionToBotMessageSchema.safeParse(parsedJson);
      if (!validated.success) {
        logger.warn(
          `nmh-socket-server: dropping schema-invalid frame: ${validated.error.message}`,
        );
        continue;
      }

      dispatchInbound(validated.data);
    }
  }

  /**
   * Replace `activeSocket` with `next`, tearing down the previous one with
   * a warning so the operator can see that the shim reconnected.
   */
  function acceptClient(next: Socket): void {
    if (activeSocket) {
      logger.warn(
        "nmh-socket-server: closing previous client; a new connection arrived",
      );
      try {
        activeSocket.destroy();
      } catch {
        // Best-effort; the previous socket might already be gone.
      }
    }
    // Reset handshake state before exposing the new socket: the previous
    // client's `ready=true` must not leak forward, or a `waitForReady()` call
    // issued after the reconnect would resolve immediately against the stale
    // flag and let the bot send commands before the new shim has handshaken.
    ready = false;
    activeSocket = next;
    // Per-connection state resets on every new accept — a stale half-line
    // from the old socket must not bleed into the new one.
    inboundBuffer = "";

    next.setEncoding("utf8");
    next.on("data", (chunk) => {
      // Node types `data` as `string | Buffer` depending on whether
      // `setEncoding` was called. We set utf8 above, so this is always a
      // string in practice.
      handleData(chunk as string);
    });
    next.on("error", (err) => {
      // `error` on a Unix socket is usually ECONNRESET from the peer
      // vanishing. We don't want this to crash the server.
      logger.warn(`nmh-socket-server: client error: ${err.message}`);
    });
    next.on("close", () => {
      if (activeSocket === next) {
        activeSocket = null;
        inboundBuffer = "";
      }
    });
  }

  return {
    async start(): Promise<void> {
      if (started) return;

      // Clear a stale socket file from a previous crashed run. Ignore
      // "file doesn't exist" (the common case on a fresh start).
      await unlink(socketPath).catch((err: NodeJS.ErrnoException) => {
        if (err?.code !== "ENOENT") {
          logger.warn(
            `nmh-socket-server: could not unlink stale socket: ${err.message}`,
          );
        }
      });

      const srv = createServer((socket) => {
        acceptClient(socket);
      });
      server = srv;

      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error): void => {
            srv.off("listening", onListening);
            reject(err);
          };
          const onListening = (): void => {
            srv.off("error", onError);
            resolve();
          };
          srv.once("error", onError);
          srv.once("listening", onListening);
          srv.listen(socketPath);
        });
      } catch (err) {
        // Listen failed — drop the unbound server reference so a retry can
        // construct a fresh one, and leave `started=false` so callers aren't
        // locked out of retrying.
        server = null;
        throw err;
      }

      // Only now that the listener is bound do we flip `started`: otherwise a
      // failed `listen()` would leave the server permanently marked started
      // and subsequent `start()` calls would silently no-op.
      started = true;
      logger.info(`nmh-socket-server: listening on ${socketPath}`);
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;

      // Reject any pending ready waiters so callers blocked in
      // `waitForReady` don't hang forever after shutdown.
      flushReadyWaiters(
        new Error("nmh-socket-server: stopped before handshake completed"),
      );

      if (activeSocket) {
        try {
          activeSocket.destroy();
        } catch {
          // Best-effort.
        }
        activeSocket = null;
      }

      const srv = server;
      server = null;
      if (srv) {
        await new Promise<void>((resolve) => {
          srv.close(() => resolve());
        });
      }

      await unlink(socketPath).catch((err: NodeJS.ErrnoException) => {
        // Missing file on stop is fine (e.g. start() never completed).
        if (err?.code !== "ENOENT") {
          logger.warn(
            `nmh-socket-server: could not unlink socket on stop: ${err.message}`,
          );
        }
      });
    },

    sendToExtension(msg: BotToExtensionMessage): void {
      if (!activeSocket) {
        throw new Error(
          "nmh-socket-server: no extension client connected; cannot send",
        );
      }
      // Re-validate outbound so a caller-side bug (e.g. assembling a
      // command with a missing field) surfaces here rather than being
      // dropped by the extension side silently.
      const parsed = BotToExtensionMessageSchema.parse(msg);
      activeSocket.write(`${JSON.stringify(parsed)}\n`);
    },

    onExtensionMessage(cb: (msg: ExtensionToBotMessage) => void): void {
      listeners.push(cb);
    },

    waitForReady(timeoutMs: number): Promise<void> {
      if (ready) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = readyWaiters.findIndex((w) => w.timer === timer);
          if (idx !== -1) readyWaiters.splice(idx, 1);
          reject(
            new Error(
              `nmh-socket-server: timed out after ${timeoutMs}ms waiting for extension ready handshake`,
            ),
          );
        }, timeoutMs);
        readyWaiters.push({ resolve, reject, timer });
      });
    },
  };
}

/** Render an unknown throwable as a short string suitable for a log line. */
function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * MeetAudioIngest — daemon-side audio ingress for a meet-bot container.
 *
 * Flow:
 *   1. The session manager calls {@link MeetAudioIngest.start} **before** the
 *      bot container is spawned. `start()` opens a Unix-domain-socket server
 *      (the bot connects as the client once it boots) and opens a Deepgram
 *      realtime streaming session reusing the existing
 *      {@link DeepgramRealtimeTranscriber}.
 *   2. When the bot connects to the socket, its raw PCM frames are forwarded
 *      byte-for-byte to the Deepgram session.
 *   3. Deepgram's `partial` / `final` transcript events are wrapped in a
 *      {@link TranscriptChunkEvent} and dispatched through
 *      {@link MeetSessionEventRouter} keyed by `meetingId`.
 *   4. On session teardown, {@link MeetAudioIngest.stop} closes the Deepgram
 *      session, tears down the socket server, and unlinks the socket file.
 *
 * Timeouts:
 *   - If the bot has not connected within {@link BOT_CONNECT_TIMEOUT_MS},
 *     `start()` rejects. The session manager treats this as a join failure
 *     so we do not leave a zombie container running against a dead ingest.
 *
 * Design notes:
 *   - The existing Deepgram realtime module is consumed **unchanged**. This
 *     means we only surface the information that module emits today —
 *     `speakerLabel` and `confidence` are left unset on the wire because the
 *     existing transcriber normalises Deepgram's frames to plain text plus
 *     is-final. That is intentionally conservative; later PRs can widen the
 *     transcriber's event shape and populate those fields here.
 *   - All external dependencies (Deepgram session, socket listener) are
 *     swapped via constructor-level factories so tests can drive the class
 *     without touching real sockets or a real Deepgram account.
 */

import { existsSync, unlinkSync } from "node:fs";
import {
  createServer as netCreateServer,
  type Server as NetServer,
  type Socket as NetSocket,
} from "node:net";

import type { TranscriptChunkEvent } from "@vellumai/meet-contracts";

import { DeepgramRealtimeTranscriber } from "../providers/speech-to-text/deepgram-realtime.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../stt/types.js";
import { getLogger } from "../util/logger.js";
import { getMeetSessionEventRouter } from "./session-event-router.js";

const log = getLogger("meet-audio-ingest");

/**
 * Maximum wall-clock time the bot is given to connect to the audio socket
 * after `start()` opens it. Exceeding this rejects `start()` with a clear
 * error so the session manager can abort the join and clean up the
 * container.
 */
export const BOT_CONNECT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Minimal socket-server abstraction
// ---------------------------------------------------------------------------

/**
 * Minimal socket-server interface consumed by {@link MeetAudioIngest}.
 *
 * Modeled on `node:net`'s `Server` with only the methods we actually use —
 * keeping the surface small makes the factory override easier to mock in
 * tests without pulling in the full net module types.
 */
export interface UnixSocketServer {
  /** Register a listener for inbound client connections. */
  onConnection(listener: (socket: UnixSocketConnection) => void): void;
  /** Register a listener for server-level errors. */
  onError(listener: (err: Error) => void): void;
  /**
   * Close the server and stop accepting new connections. The returned
   * promise resolves once the underlying server has fully closed.
   */
  close(): Promise<void>;
}

/**
 * Minimal single-connection interface consumed by {@link MeetAudioIngest}.
 *
 * Keyed off `node:net`'s `Socket` but intentionally narrower — we only use
 * data/close/error listeners and a destroy method.
 */
export interface UnixSocketConnection {
  onData(listener: (chunk: Buffer) => void): void;
  onClose(listener: () => void): void;
  onError(listener: (err: Error) => void): void;
  destroy(): void;
}

/**
 * Factory signature used to open the Unix-socket server. Production code
 * passes the default (node:net) implementation; tests inject a shim.
 */
export type UnixSocketListenFn = (
  socketPath: string,
) => Promise<UnixSocketServer>;

// ---------------------------------------------------------------------------
// Deepgram factory
// ---------------------------------------------------------------------------

/**
 * Options forwarded to the Deepgram factory. Mirrors the option surface of
 * {@link DeepgramRealtimeTranscriber} so tests can assert on what the
 * ingest configured.
 */
export interface DeepgramIngestOptions {
  /** Deepgram API key used to authenticate the streaming session. */
  apiKey: string;
  /** Whether to request smart-formatting (punctuation, numerals). */
  smartFormatting: boolean;
  /** Whether to request interim (partial) transcript events. */
  interimResults: boolean;
}

/**
 * Factory signature for constructing the Deepgram streaming session.
 *
 * Returning a {@link StreamingTranscriber} keeps the audio-ingest code
 * decoupled from the concrete Deepgram class — tests pass an in-memory
 * fake that conforms to the same contract.
 */
export type DeepgramSessionFactory = (
  options: DeepgramIngestOptions,
) => StreamingTranscriber;

// ---------------------------------------------------------------------------
// MeetAudioIngest
// ---------------------------------------------------------------------------

export interface MeetAudioIngestDeps {
  /** Override for the Deepgram session factory (tests). */
  createDeepgramSession?: DeepgramSessionFactory;
  /** Override for the Unix-socket listener factory (tests). */
  listen?: UnixSocketListenFn;
  /** Override the bot-connect timeout (tests). */
  botConnectTimeoutMs?: number;
}

/**
 * Per-meeting audio ingress bridge. Instances are 1:1 with a meet-bot
 * container and are owned by the session manager — callers must not reuse
 * an ingest across meetings.
 */
export class MeetAudioIngest {
  private readonly createDeepgramSession: DeepgramSessionFactory;
  private readonly listen: UnixSocketListenFn;
  private readonly botConnectTimeoutMs: number;

  /** Stored only for teardown — set in `start()`. */
  private socketPath: string | null = null;
  private server: UnixSocketServer | null = null;
  private connection: UnixSocketConnection | null = null;
  private transcriber: StreamingTranscriber | null = null;
  private meetingId: string | null = null;
  private stopped = false;

  constructor(deps: MeetAudioIngestDeps = {}) {
    this.createDeepgramSession =
      deps.createDeepgramSession ?? defaultCreateDeepgramSession;
    this.listen = deps.listen ?? defaultListen;
    this.botConnectTimeoutMs =
      deps.botConnectTimeoutMs ?? BOT_CONNECT_TIMEOUT_MS;
  }

  /**
   * Open the Unix-socket server the bot will connect to, start a Deepgram
   * realtime session, and wire PCM frames into it.
   *
   * The promise resolves once:
   *   - the socket server is listening, AND
   *   - the Deepgram streaming session has connected.
   *
   * It rejects if either step fails or if the bot has not connected within
   * {@link BOT_CONNECT_TIMEOUT_MS} of `start()` being called.
   */
  async start(
    meetingId: string,
    socketPath: string,
    apiKey: string,
  ): Promise<void> {
    if (this.meetingId) {
      throw new Error(
        `MeetAudioIngest: start() called twice (meetingId=${this.meetingId})`,
      );
    }
    this.meetingId = meetingId;
    this.socketPath = socketPath;

    // Remove any stale socket file left over from a previous run so
    // `listen()` doesn't fail with EADDRINUSE.
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch (err) {
        log.warn(
          { err, socketPath },
          "Failed to unlink stale audio socket (continuing)",
        );
      }
    }

    // Open the Deepgram streaming session first. We want the socket server
    // to be able to pump audio into an already-connected Deepgram session
    // as soon as the bot connects.
    const transcriber = this.createDeepgramSession({
      apiKey,
      smartFormatting: true,
      interimResults: true,
    });
    this.transcriber = transcriber;

    try {
      await transcriber.start((event) =>
        this.handleTranscriberEvent(meetingId, event),
      );
    } catch (err) {
      this.transcriber = null;
      this.meetingId = null;
      this.socketPath = null;
      throw err;
    }

    // Open the Unix-socket server. The bot will dial this path from inside
    // its container as soon as it boots.
    let server: UnixSocketServer;
    try {
      server = await this.listen(socketPath);
    } catch (err) {
      // Deepgram is already up — tear it down before propagating the error.
      try {
        transcriber.stop();
      } catch {
        // Best effort — provider close failure shouldn't mask the original.
      }
      this.transcriber = null;
      this.meetingId = null;
      this.socketPath = null;
      throw err;
    }
    this.server = server;

    server.onError((err) => {
      log.error({ err, meetingId }, "MeetAudioIngest: socket server error");
    });

    // Wait for the bot to connect, bounded by BOT_CONNECT_TIMEOUT_MS.
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        log.warn(
          { meetingId, socketPath, timeoutMs: this.botConnectTimeoutMs },
          "MeetAudioIngest: bot did not connect within timeout",
        );
        reject(
          new Error(
            `MeetAudioIngest: bot did not connect to ${socketPath} within ${this.botConnectTimeoutMs}ms`,
          ),
        );
      }, this.botConnectTimeoutMs);

      server.onConnection((conn) => {
        if (settled) {
          // Late connection after we already rejected — drop it so the
          // caller's teardown path can proceed cleanly.
          try {
            conn.destroy();
          } catch {
            // Best effort.
          }
          return;
        }
        settled = true;
        clearTimeout(timer);

        this.connection = conn;
        this.wireConnection(conn, meetingId);
        resolve();
      });
    });

    log.info({ meetingId, socketPath }, "MeetAudioIngest: bot connected");
  }

  /**
   * Tear down the ingest:
   *   1. Stop forwarding audio.
   *   2. Close the Deepgram session (provider may flush remaining finals).
   *   3. Close the socket server.
   *   4. Unlink the socket file.
   *
   * Idempotent — calling `stop()` twice is a no-op after the first call.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    // Destroy the connection first so the bot sees a clean EOF.
    const conn = this.connection;
    this.connection = null;
    if (conn) {
      try {
        conn.destroy();
      } catch (err) {
        log.warn({ err }, "MeetAudioIngest: connection destroy threw");
      }
    }

    // Close the Deepgram session. The transcriber signals `closed` via its
    // event callback — we don't need to await that signal here because the
    // ingress is shutting down regardless.
    const transcriber = this.transcriber;
    this.transcriber = null;
    if (transcriber) {
      try {
        transcriber.stop();
      } catch (err) {
        log.warn({ err }, "MeetAudioIngest: transcriber stop threw");
      }
    }

    // Shut the socket server.
    const server = this.server;
    this.server = null;
    if (server) {
      try {
        await server.close();
      } catch (err) {
        log.warn({ err }, "MeetAudioIngest: server close threw");
      }
    }

    // Unlink the socket file best-effort — the file may already be gone
    // (e.g. the workspace directory was cleaned up).
    const socketPath = this.socketPath;
    this.socketPath = null;
    if (socketPath && existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch (err) {
        log.warn(
          { err, socketPath },
          "MeetAudioIngest: socket unlink threw — file may leak",
        );
      }
    }

    log.info(
      { meetingId: this.meetingId },
      "MeetAudioIngest: stopped",
    );
  }

  // ── Internals ──────────────────────────────────────────────────────

  /**
   * Forward inbound bytes to the transcriber and log connection lifecycle.
   */
  private wireConnection(
    conn: UnixSocketConnection,
    meetingId: string,
  ): void {
    conn.onData((chunk) => {
      if (this.stopped) return;
      const transcriber = this.transcriber;
      if (!transcriber) return;
      try {
        // Deepgram's live endpoint accepts raw PCM bytes. The mimeType is
        // informational for other providers; pass a sensible default.
        transcriber.sendAudio(chunk, "audio/pcm");
      } catch (err) {
        log.warn(
          { err, meetingId },
          "MeetAudioIngest: transcriber.sendAudio threw",
        );
      }
    });

    conn.onClose(() => {
      log.info({ meetingId }, "MeetAudioIngest: bot connection closed");
    });

    conn.onError((err) => {
      log.warn({ err, meetingId }, "MeetAudioIngest: bot connection error");
    });
  }

  /**
   * Translate a Deepgram streaming event into a TranscriptChunkEvent and
   * dispatch it through the session router. Errors, closes, and other
   * non-transcript events are ignored — the session manager owns the
   * provider's lifecycle, not the ingest.
   */
  private handleTranscriberEvent(
    meetingId: string,
    event: SttStreamServerEvent,
  ): void {
    if (event.type !== "partial" && event.type !== "final") {
      // `closed` and `error` are internal-only — the session manager
      // already tracks session health via the container watcher.
      return;
    }

    // The existing Deepgram transcriber does not yet surface speaker /
    // confidence metadata; leave those optional fields unset.
    const transcript: TranscriptChunkEvent = {
      type: "transcript.chunk",
      meetingId,
      timestamp: new Date().toISOString(),
      isFinal: event.type === "final",
      text: event.text,
    };

    getMeetSessionEventRouter().dispatch(meetingId, transcript);
  }
}

// ---------------------------------------------------------------------------
// Defaults — real Deepgram + real node:net socket server
// ---------------------------------------------------------------------------

/**
 * Default Deepgram factory — constructs the production
 * {@link DeepgramRealtimeTranscriber} with the options mirrored from the
 * existing provider module (smart formatting + interim results on).
 *
 * Phase 1 does **not** require diarization; the existing transcriber does
 * not expose a `diarize` knob, and the plan is explicit that the module is
 * consumed unchanged. A later PR can widen the transcriber's option
 * surface when we need speaker labels.
 */
function defaultCreateDeepgramSession(
  options: DeepgramIngestOptions,
): StreamingTranscriber {
  return new DeepgramRealtimeTranscriber(options.apiKey, {
    smartFormatting: options.smartFormatting,
    interimResults: options.interimResults,
  });
}

/**
 * Default socket-server factory — opens a `node:net` server listening on
 * the Unix-domain path. Each incoming connection is wrapped in a small
 * shim implementing {@link UnixSocketConnection}.
 */
function defaultListen(socketPath: string): Promise<UnixSocketServer> {
  return new Promise<UnixSocketServer>((resolve, reject) => {
    let settled = false;
    const connectionListeners: Array<
      (conn: UnixSocketConnection) => void
    > = [];
    const errorListeners: Array<(err: Error) => void> = [];

    const netServer: NetServer = netCreateServer((socket) => {
      const conn = adaptNetSocket(socket);
      for (const listener of connectionListeners) {
        try {
          listener(conn);
        } catch (err) {
          log.warn({ err }, "MeetAudioIngest: connection listener threw");
        }
      }
    });

    netServer.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
        return;
      }
      for (const listener of errorListeners) {
        try {
          listener(err);
        } catch (cbErr) {
          log.warn({ cbErr }, "MeetAudioIngest: error listener threw");
        }
      }
    });

    netServer.listen(socketPath, () => {
      if (settled) return;
      settled = true;

      const wrapped: UnixSocketServer = {
        onConnection: (listener) => {
          connectionListeners.push(listener);
        },
        onError: (listener) => {
          errorListeners.push(listener);
        },
        close: () =>
          new Promise<void>((resolveClose) => {
            netServer.close(() => resolveClose());
          }),
      };
      resolve(wrapped);
    });
  });
}

/**
 * Adapt a raw `node:net` Socket to the narrow
 * {@link UnixSocketConnection} surface consumed by the ingest.
 */
function adaptNetSocket(socket: NetSocket): UnixSocketConnection {
  return {
    onData: (listener) => socket.on("data", listener),
    onClose: (listener) => socket.on("close", listener),
    onError: (listener) => socket.on("error", listener),
    destroy: () => socket.destroy(),
  };
}

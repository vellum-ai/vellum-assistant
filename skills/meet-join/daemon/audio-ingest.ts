/**
 * MeetAudioIngest — daemon-side audio ingress for a meet-bot container.
 *
 * Flow:
 *   1. The session manager calls {@link MeetAudioIngest.start} **before** the
 *      bot container is spawned. `start()` opens a Unix-domain-socket server
 *      (the bot connects as the client once it boots) and opens a streaming
 *      STT session via the configured provider (resolved from
 *      `services.stt.provider`).
 *   2. When the bot connects to the socket, its raw PCM frames are forwarded
 *      byte-for-byte to the streaming transcriber.
 *   3. The transcriber's `partial` / `final` transcript events are wrapped
 *      in a {@link TranscriptChunkEvent} and dispatched through
 *      {@link MeetSessionEventRouter} keyed by `meetingId`.
 *   4. On session teardown, {@link MeetAudioIngest.stop} closes the
 *      streaming session, tears down the socket server, and unlinks the
 *      socket file.
 *
 * Timeouts:
 *   - If the bot has not connected within {@link BOT_CONNECT_TIMEOUT_MS},
 *     `start()` rejects. The session manager treats this as a join failure
 *     so we do not leave a zombie container running against a dead ingest.
 *
 * Design notes:
 *   - The STT provider is resolved at runtime via
 *     {@link resolveStreamingTranscriber}, which reads
 *     `services.stt.provider` and looks up credentials through the provider
 *     catalog. Meet transcription therefore honors the same provider
 *     selection as the rest of the assistant.
 *   - Provider-specific options (e.g. Deepgram's `smartFormatting` /
 *     `interimResults`) are owned by each provider's config schema.
 *   - All external dependencies (transcriber factory, socket listener) are
 *     swapped via constructor-level factories so tests can drive the class
 *     without touching real sockets or a real STT provider account.
 */

import { existsSync, unlinkSync } from "node:fs";
import {
  createServer as netCreateServer,
  type Server as NetServer,
  type Socket as NetSocket,
} from "node:net";

import type { TranscriptChunkEvent } from "../contracts/index.js";

import { resolveStreamingTranscriber } from "../../../assistant/src/providers/speech-to-text/resolve.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../../assistant/src/stt/types.js";
import { getLogger } from "../../../assistant/src/util/logger.js";
import { getMeetSessionEventRouter } from "./session-event-router.js";

const log = getLogger("meet-audio-ingest");

/**
 * Maximum wall-clock time the bot is given to connect to the audio socket
 * after `start()` opens it. Exceeding this rejects `start()` with a clear
 * error so the session manager can abort the join and clean up the
 * container.
 *
 * Must be larger than the bot's worst-case prejoin+admission path, not just
 * its connect cost. The bot only opens the audio socket *after* `joinMeet`
 * returns, and `joinMeet` may legitimately block for `MEETING_ROOM_TIMEOUT_MS`
 * (90s) while a host admits the bot through the "Ask to join" lobby. Plus
 * cold-start (Chrome launch + Meet page load + modal dismissal) adds another
 * ~10s. Anything under ~100s races the join flow and causes the daemon to
 * rollback a bot that was still legitimately mid-join.
 */
export const BOT_CONNECT_TIMEOUT_MS = 120_000;

/**
 * Sample rate (Hz) of the PCM frames the meet-bot captures and forwards over
 * the audio socket. Mirrors `DEFAULT_RATE_HZ` in
 * `skills/meet-join/bot/src/media/audio-capture.ts` — duplicated here rather
 * than imported because the daemon does not import from the bot package
 * (they ship as separate artifacts). Must be kept in sync with the bot's
 * capture rate and passed explicitly to each STT adapter so ingest does not
 * silently rely on any per-provider default; a mismatch would cause the
 * provider to decode at the wrong rate and produce garbled transcripts.
 */
const MEET_BOT_SAMPLE_RATE_HZ = 16_000;

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Marker error thrown by {@link MeetAudioIngest} when the ingest cannot
 * start because no streaming-capable STT provider is configured or the
 * configured provider lacks credentials.
 *
 * Exported as a named subclass so callers that need to distinguish this
 * from generic ingest errors can use `instanceof MeetAudioIngestError`.
 */
export class MeetAudioIngestError extends Error {
  readonly name = "MeetAudioIngestError";

  constructor(message: string) {
    super(message);
  }
}

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
// Streaming transcriber factory
// ---------------------------------------------------------------------------

/**
 * Factory signature for constructing the streaming STT session.
 *
 * Returning a {@link StreamingTranscriber} keeps the audio-ingest code
 * decoupled from any specific provider — production wiring uses the
 * configured provider via {@link resolveStreamingTranscriber}; tests pass
 * an in-memory fake that conforms to the same contract.
 */
export type StreamingTranscriberFactory = () => Promise<StreamingTranscriber>;

// ---------------------------------------------------------------------------
// MeetAudioIngest
// ---------------------------------------------------------------------------

export interface MeetAudioIngestDeps {
  /** Override for the streaming-transcriber factory (tests). */
  createTranscriber?: StreamingTranscriberFactory;
  /** Override for the Unix-socket listener factory (tests). */
  listen?: UnixSocketListenFn;
  /** Override the bot-connect timeout (tests). */
  botConnectTimeoutMs?: number;
}

/** Callback invoked for each PCM chunk received from the bot. */
export type PcmSubscriber = (bytes: Uint8Array) => void;

/**
 * Per-meeting audio ingress bridge. Instances are 1:1 with a meet-bot
 * container and are owned by the session manager — callers must not reuse
 * an ingest across meetings.
 */
export class MeetAudioIngest {
  private readonly createTranscriber: StreamingTranscriberFactory;
  private readonly listen: UnixSocketListenFn;
  private readonly botConnectTimeoutMs: number;

  /** Stored only for teardown — set in `start()`. */
  private socketPath: string | null = null;
  private server: UnixSocketServer | null = null;
  private connection: UnixSocketConnection | null = null;
  private transcriber: StreamingTranscriber | null = null;
  private meetingId: string | null = null;
  private stopped = false;

  /**
   * Callbacks subscribed to the raw PCM stream. Each inbound chunk from the
   * bot is forwarded to the streaming transcriber AND to every subscriber
   * here so multiple consumers (e.g. the storage writer's ffmpeg pipe) can
   * observe the same bytes without competing for the socket.
   */
  private readonly pcmSubscribers = new Set<PcmSubscriber>();

  constructor(deps: MeetAudioIngestDeps = {}) {
    this.createTranscriber = deps.createTranscriber ?? defaultCreateTranscriber;
    this.listen = deps.listen ?? defaultListen;
    this.botConnectTimeoutMs =
      deps.botConnectTimeoutMs ?? BOT_CONNECT_TIMEOUT_MS;
  }

  /**
   * Register a callback to receive every raw PCM chunk as it arrives from
   * the bot. Subscribers are invoked synchronously for each chunk in
   * addition to the transcriber forward. A subscriber that throws is
   * logged and removed so one misbehaving consumer cannot break peers.
   *
   * Returns an unsubscribe function. Safe to call before `start()` — the
   * subscriber picks up the very next chunk once the socket is wired.
   */
  subscribePcm(cb: PcmSubscriber): () => void {
    this.pcmSubscribers.add(cb);
    return () => {
      this.pcmSubscribers.delete(cb);
    };
  }

  /**
   * Open the Unix-socket server the bot will connect to, start a streaming
   * STT session, and wire PCM frames into it.
   *
   * The promise resolves once:
   *   - the socket server is listening, AND
   *   - the streaming session has connected.
   *
   * It rejects if either step fails or if the bot has not connected within
   * {@link BOT_CONNECT_TIMEOUT_MS} of `start()` being called. Rejections
   * due to missing provider configuration surface as
   * {@link MeetAudioIngestError}.
   */
  async start(meetingId: string, socketPath: string): Promise<void> {
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

    // Open the streaming STT session first. We want the socket server
    // to be able to pump audio into an already-connected session as
    // soon as the bot connects.
    let transcriber: StreamingTranscriber;
    try {
      transcriber = await this.createTranscriber();
    } catch (err) {
      this.meetingId = null;
      this.socketPath = null;
      throw err;
    }
    if (this.stopped) return;
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
    if (this.stopped) return;

    // Open the Unix-socket server. The bot will dial this path from inside
    // its container as soon as it boots.
    let server: UnixSocketServer;
    try {
      server = await this.listen(socketPath);
    } catch (err) {
      // Streaming session is already up — tear it down before propagating.
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
   *   2. Close the streaming session (provider may flush remaining finals).
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

    // Close the streaming session. The transcriber signals `closed` via
    // its event callback — we don't need to await that signal here because
    // the ingress is shutting down regardless.
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

    // Drop any lingering PCM subscribers so they can't keep a reference to
    // the ingest alive past stop. Subscribers that unsubscribed on their
    // own (e.g. the storage writer on `stop()`) are already gone.
    this.pcmSubscribers.clear();

    log.info({ meetingId: this.meetingId }, "MeetAudioIngest: stopped");
  }

  // ── Internals ──────────────────────────────────────────────────────

  /**
   * Forward inbound bytes to the transcriber and fan them out to every PCM
   * subscriber. Subscribers that throw are logged and evicted so one
   * misbehaving consumer cannot break peers.
   */
  private wireConnection(conn: UnixSocketConnection, meetingId: string): void {
    conn.onData((chunk) => {
      if (this.stopped) return;
      const transcriber = this.transcriber;
      if (transcriber) {
        try {
          // The streaming endpoint accepts raw PCM bytes. The mimeType is
          // informational for provider adapters; pass a sensible default.
          transcriber.sendAudio(chunk, "audio/pcm");
        } catch (err) {
          log.warn(
            { err, meetingId },
            "MeetAudioIngest: transcriber.sendAudio threw",
          );
        }
      }
      // Fan the raw bytes out to every PCM subscriber. Snapshot the set so
      // a callback removing itself mid-iteration doesn't skip a neighbor.
      // Subscribers that throw are logged and removed on the spot.
      if (this.pcmSubscribers.size > 0) {
        for (const subscriber of Array.from(this.pcmSubscribers)) {
          try {
            subscriber(chunk);
          } catch (err) {
            log.warn(
              { err, meetingId },
              "MeetAudioIngest: PCM subscriber threw — removing",
            );
            this.pcmSubscribers.delete(subscriber);
          }
        }
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
   * Translate a streaming STT event into a TranscriptChunkEvent and
   * dispatch it through the session router. Errors, closes, and other
   * non-transcript events are ignored — the session manager owns the
   * provider's lifecycle, not the ingest.
   *
   * When the provider emits a `speakerLabel` (Deepgram diarization is
   * enabled for Meet audio), forward it on the transcript chunk so
   * {@link MeetSpeakerResolver} can bind the opaque ASR label to a real
   * participant identity. `confidence` rides along when the provider
   * surfaces it.
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

    // `speakerLabel` is populated by provider adapters that support
    // diarization (currently Deepgram). Non-diarizing providers leave it
    // undefined — downstream consumers treat that as "unknown speaker".
    // Stable `speakerId` remains unset; the speaker resolver (PR 7)
    // derives it by cross-checking the label against Meet's DOM-sourced
    // active-speaker signal. `confidence` rides through when the
    // provider surfaces it so observers can weight low-confidence chunks.
    const transcript: TranscriptChunkEvent = {
      type: "transcript.chunk",
      meetingId,
      timestamp: new Date().toISOString(),
      isFinal: event.type === "final",
      text: event.text,
      ...(event.speakerLabel !== undefined
        ? { speakerLabel: String(event.speakerLabel) }
        : {}),
      ...(event.confidence !== undefined
        ? { confidence: event.confidence }
        : {}),
    };

    getMeetSessionEventRouter().dispatch(meetingId, transcript);
  }
}

// ---------------------------------------------------------------------------
// Defaults — resolve the configured STT provider + real node:net socket
// ---------------------------------------------------------------------------

/**
 * Default streaming-transcriber factory — resolves the provider via the
 * assistant's STT catalog (reads `services.stt.provider` and looks up
 * credentials centrally).
 *
 * Meet audio ingest always requests diarization so {@link MeetSpeakerResolver}
 * can bind opaque ASR speaker labels to real participant identities.
 * Providers without diarization support silently ignore the flag.
 *
 * Passes the meet-bot's capture sample rate through to the resolver so
 * Meet's audio ingest does not depend on any adapter's per-provider default.
 * All three streaming adapters happen to default to 16 kHz today, but being
 * explicit insulates us from a future adapter changing its default out from
 * under ingest.
 *
 * Requests `diarize: "preferred"` so capable providers (Deepgram) emit
 * speaker labels that the downstream speaker resolver can cross-check
 * against Meet's DOM-sourced active-speaker signal. Providers that
 * don't support diarization (Gemini, Whisper) silently no-op — Meet
 * still works, the DOM remains the only speaker source.
 *
 * Throws {@link MeetAudioIngestError} when the resolver returns `null`.
 * With `"preferred"` that only happens when the configured STT provider
 * is entirely unusable (unknown provider, no streaming support, missing
 * credentials, or no adapter) — never due to a lack of diarization
 * capability. The error message points the user at
 * `services.stt.provider`.
 */
async function defaultCreateTranscriber(): Promise<StreamingTranscriber> {
  const transcriber = await resolveStreamingTranscriber({
    sampleRate: MEET_BOT_SAMPLE_RATE_HZ,
    // `"preferred"`: enable diarization when the configured provider can
    // do it, but don't refuse to start on providers that can't — Meet
    // falls back to DOM-based speaker attribution via MeetSpeakerResolver.
    diarize: "preferred",
  });
  if (!transcriber) {
    throw new MeetAudioIngestError(
      "The configured STT provider is unusable for Meet transcription. " +
        "Set services.stt.provider to deepgram, google-gemini, or openai-whisper " +
        "and ensure credentials are present.",
    );
  }
  return transcriber;
}

/**
 * Default socket-server factory — opens a `node:net` server listening on
 * the Unix-domain path. Each incoming connection is wrapped in a small
 * shim implementing {@link UnixSocketConnection}.
 */
function defaultListen(socketPath: string): Promise<UnixSocketServer> {
  return new Promise<UnixSocketServer>((resolve, reject) => {
    let settled = false;
    const connectionListeners: Array<(conn: UnixSocketConnection) => void> = [];
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

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

import { timingSafeEqual } from "node:crypto";
import {
  createServer as netCreateServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket as NetSocket,
} from "node:net";

import type { TranscriptChunkEvent } from "../contracts/index.js";

import {
  listProviderIds,
  supportsBoundary,
} from "../../../assistant/src/providers/speech-to-text/provider-catalog.js";
import { resolveStreamingTranscriber } from "../../../assistant/src/providers/speech-to-text/resolve.js";
import type {
  StreamingTranscriber,
  SttStreamServerEvent,
} from "../../../assistant/src/stt/types.js";
import { getLogger } from "../../../assistant/src/util/logger.js";
import { getMeetSessionEventRouter } from "./session-event-router.js";

const log = getLogger("meet-audio-ingest");

/**
 * Host the audio-ingest TCP server binds to. Must be all-interfaces
 * (`0.0.0.0`) rather than loopback: on vanilla Linux Docker, the bot
 * reaches us via `host.docker.internal:host-gateway`, which resolves to
 * the Docker bridge gateway IP — packets arrive at the bridge interface,
 * not loopback, so a listener bound to `127.0.0.1` would refuse them.
 * The assistant HTTP port has the same constraint (see
 * `cli/src/lib/__tests__/docker.test.ts` for the documented test).
 * macOS and Windows Docker forward `host.docker.internal` to loopback,
 * so they work either way; binding all-interfaces is the common case
 * that works across every Docker platform we support.
 */
export const AUDIO_INGEST_BIND_HOST = "0.0.0.0";

/**
 * Maximum wall-clock time the bot is given to connect to the audio port
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
 * Wire-format prefix for the handshake line the bot sends as the first
 * bytes of every audio-ingest TCP connection. The full line is
 * `AUTH <botApiToken>\n`. Anything else — or a connection that opens
 * more than {@link MAX_HANDSHAKE_BYTES} without a newline, or that does
 * not finish its handshake within {@link HANDSHAKE_TIMEOUT_MS} — is
 * dropped.
 *
 * The handshake exists because `AUDIO_INGEST_BIND_HOST` binds the TCP
 * server to all interfaces (required so Linux Docker bots reach the
 * daemon via `host.docker.internal:host-gateway`), which also means any
 * other process on the host's LAN could race-connect and either inject
 * raw PCM or hold the port open until the bot's connect watchdog trips.
 * Reusing `BOT_API_TOKEN` (already generated per-meeting and shared with
 * the bot through its env) keeps the secret surface area the same as
 * the bot's HTTP API.
 */
export const AUDIO_INGEST_AUTH_PREFIX = "AUTH ";

/**
 * Wall-clock budget the bot has after TCP connect to deliver the
 * handshake line. Intentionally short — a legitimate bot writes the
 * line synchronously as the first bytes after `connect()` returns, so
 * any delay past a few seconds is either a stuck attacker or a failed
 * bot. We still keep the overall bot-connect budget at
 * {@link BOT_CONNECT_TIMEOUT_MS} because the handshake fires against
 * each individual connection, not against the listener as a whole.
 */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Maximum bytes we buffer while waiting for the handshake's newline.
 * Well above the handshake's true length (`"AUTH " + 64-char hex + "\n"`
 * = 70 bytes) so benign TCP re-segmentation doesn't trip it, but small
 * enough that a peer who never sends `\n` cannot pin arbitrary memory.
 */
export const MAX_HANDSHAKE_BYTES = 256;

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
export interface AudioIngestServer {
  /** TCP port the server accepted its bind on. */
  readonly port: number;
  /** Register a listener for inbound client connections. */
  onConnection(listener: (socket: AudioIngestConnection) => void): void;
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
export interface AudioIngestConnection {
  onData(listener: (chunk: Buffer) => void): void;
  onClose(listener: () => void): void;
  onError(listener: (err: Error) => void): void;
  destroy(): void;
}

/**
 * Factory signature used to open the audio-ingest TCP server. Production
 * code passes the default (node:net) implementation; tests inject a shim.
 * The factory binds to an OS-assigned port on loopback and returns the
 * server handle with the resolved port exposed.
 */
export type AudioIngestListenFn = () => Promise<AudioIngestServer>;

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
  /** Override for the audio-ingest TCP listener factory (tests). */
  listen?: AudioIngestListenFn;
  /** Override the bot-connect timeout (tests). */
  botConnectTimeoutMs?: number;
  /**
   * Whether speaker diarization is enabled for this session. When `false`,
   * `speakerLabel` is stripped from emitted {@link TranscriptChunkEvent}s
   * even if the provider happens to include one — downstream consumers
   * (speaker resolver, storage writer) should not attempt label-based
   * attribution when diarization was not requested. Defaults to `true`.
   */
  diarize?: boolean;
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
  private readonly listen: AudioIngestListenFn;
  private readonly botConnectTimeoutMs: number;
  private readonly diarize: boolean;

  private server: AudioIngestServer | null = null;
  private connection: AudioIngestConnection | null = null;
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
    this.diarize = deps.diarize ?? true;
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
   * Open the audio-ingest TCP server the bot will connect to, start a
   * streaming STT session, and wire PCM frames into it.
   *
   * Returns a two-phase handle:
   *   - `port` — the OS-assigned port the server is bound to (on all
   *     interfaces — see {@link AUDIO_INGEST_BIND_HOST}).
   *     Available as soon as the outer promise resolves, so the caller can
   *     thread it into the bot container's env before spawning.
   *   - `ready` — resolves once the bot has actually connected; rejects
   *     if the bot fails to connect within {@link BOT_CONNECT_TIMEOUT_MS}.
   *
   * The outer promise rejects if the STT session fails to open or the
   * server cannot bind. Rejections due to missing provider configuration
   * surface as {@link MeetAudioIngestError}.
   *
   * Splitting "port available" from "bot connected" lets the session
   * manager keep container spawn concurrent with the bot-connect wait
   * without losing the env-var threading we need to point the bot at a
   * per-meeting port.
   */
  async start(
    meetingId: string,
    botApiToken: string,
  ): Promise<{ port: number; ready: Promise<void> }> {
    if (this.meetingId) {
      throw new Error(
        `MeetAudioIngest: start() called twice (meetingId=${this.meetingId})`,
      );
    }
    if (!botApiToken) {
      throw new Error(
        "MeetAudioIngest: botApiToken is required — refusing to start without an auth token",
      );
    }
    this.meetingId = meetingId;

    // Open the streaming STT session first. We want the socket server
    // to be able to pump audio into an already-connected session as
    // soon as the bot connects.
    let transcriber: StreamingTranscriber;
    try {
      transcriber = await this.createTranscriber();
    } catch (err) {
      this.meetingId = null;
      throw err;
    }
    if (this.stopped) return { port: 0, ready: Promise.resolve() };
    this.transcriber = transcriber;

    try {
      await transcriber.start((event) =>
        this.handleTranscriberEvent(meetingId, event),
      );
    } catch (err) {
      this.transcriber = null;
      this.meetingId = null;
      throw err;
    }
    if (this.stopped) return { port: 0, ready: Promise.resolve() };

    // Open the TCP server (all interfaces — see AUDIO_INGEST_BIND_HOST).
    // The bot dials it via `host.docker.internal:<port>` once its Chrome
    // extension signals `lifecycle:joined`.
    let server: AudioIngestServer;
    try {
      server = await this.listen();
    } catch (err) {
      // Streaming session is already up — tear it down before propagating.
      try {
        transcriber.stop();
      } catch {
        // Best effort — provider close failure shouldn't mask the original.
      }
      this.transcriber = null;
      this.meetingId = null;
      throw err;
    }
    // If stop() was called concurrently while listen() was in flight, it
    // already observed this.server === null and finished, so the freshly
    // returned `server` would be orphaned if we assigned it. Close it
    // locally and bail out.
    if (this.stopped) {
      try {
        await server.close();
      } catch (err) {
        log.warn({ err }, "MeetAudioIngest: server close after stop threw");
      }
      return { port: 0, ready: Promise.resolve() };
    }
    this.server = server;
    const boundPort = server.port;

    server.onError((err) => {
      log.error({ err, meetingId }, "MeetAudioIngest: socket server error");
    });

    // Wait for the bot to connect AND successfully complete the
    // auth-token handshake, bounded by BOT_CONNECT_TIMEOUT_MS. Connections
    // that fail the handshake are destroyed but do NOT reject `ready` —
    // we keep the listener open so the real bot can still connect. The
    // overall timeout is the backstop for the case where no legitimate
    // bot ever shows up.
    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        log.warn(
          { meetingId, port: boundPort, timeoutMs: this.botConnectTimeoutMs },
          "MeetAudioIngest: bot did not connect within timeout",
        );
        reject(
          new Error(
            `MeetAudioIngest: bot did not connect to *:${boundPort} within ${this.botConnectTimeoutMs}ms`,
          ),
        );
      }, this.botConnectTimeoutMs);

      server.onConnection((conn) => {
        if (settled) {
          // Late connection after we already accepted a bot (or rejected
          // on timeout) — drop it so the caller's teardown path can
          // proceed cleanly.
          try {
            conn.destroy();
          } catch {
            // Best effort.
          }
          return;
        }
        this.authenticateConnection(conn, botApiToken, {
          onAccept: (residual) => {
            if (settled) {
              // Raced another connection; drop this one.
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
            if (residual && residual.length > 0) {
              // Any bytes the bot sent after the handshake newline in the
              // same TCP segment are real PCM — forward them before
              // handing the socket to the data listener so we don't
              // silently drop them.
              this.handlePcmChunk(residual, meetingId);
            }
            log.info(
              { meetingId, port: boundPort },
              "MeetAudioIngest: bot connected and authenticated",
            );
            resolve();
          },
          onReject: (reason) => {
            // Drop the peer, keep listening for the real bot. We only
            // log a counter-style field so repeated bad handshakes
            // don't flood logs with duplicate messages.
            log.warn(
              { meetingId, port: boundPort, reason },
              "MeetAudioIngest: rejected unauthenticated audio-ingest peer",
            );
            try {
              conn.destroy();
            } catch {
              // Best effort.
            }
          },
        });
      });
    });

    return { port: boundPort, ready };
  }

  /**
   * Validate the handshake line the bot sends as the first bytes after
   * TCP connect. Calls `onAccept` with any trailing PCM bytes that
   * arrived in the same segment as the handshake (the bot pipes audio
   * immediately after writing the auth line, so the first chunk will
   * usually contain both). Calls `onReject` with a human-readable reason
   * if the handshake is malformed, mismatched, oversized, or times out.
   *
   * The caller owns the connection lifetime — `onReject` does NOT
   * destroy the socket so the caller can log/track the rejection before
   * tearing it down.
   */
  private authenticateConnection(
    conn: AudioIngestConnection,
    expectedToken: string,
    callbacks: {
      onAccept: (residual: Buffer | null) => void;
      onReject: (reason: string) => void;
    },
  ): void {
    let settled = false;
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      callbacks.onReject("handshake-timeout");
    }, HANDSHAKE_TIMEOUT_MS);

    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };

    conn.onData((chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      const handshakeLen = newline === -1 ? buffer.length : newline;
      if (handshakeLen > MAX_HANDSHAKE_BYTES) {
        finish(() => callbacks.onReject("handshake-too-long"));
        return;
      }
      if (newline === -1) return;
      const line = buffer.subarray(0, newline).toString("utf8");
      const residual =
        newline + 1 < buffer.length ? buffer.subarray(newline + 1) : null;

      if (!line.startsWith(AUDIO_INGEST_AUTH_PREFIX)) {
        finish(() => callbacks.onReject("handshake-bad-prefix"));
        return;
      }
      const presentedToken = line.slice(AUDIO_INGEST_AUTH_PREFIX.length);
      if (!constantTimeTokenEqual(presentedToken, expectedToken)) {
        finish(() => callbacks.onReject("handshake-bad-token"));
        return;
      }

      finish(() => callbacks.onAccept(residual));
    });

    conn.onClose(() => {
      if (settled) return;
      finish(() => callbacks.onReject("handshake-closed"));
    });

    conn.onError((err) => {
      if (settled) return;
      finish(() => callbacks.onReject(`handshake-error:${err.message}`));
    });
  }

  /**
   * Tear down the ingest:
   *   1. Stop forwarding audio.
   *   2. Close the streaming session (provider may flush remaining finals).
   *   3. Close the TCP server.
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
  private wireConnection(conn: AudioIngestConnection, meetingId: string): void {
    conn.onData((chunk) => this.handlePcmChunk(chunk, meetingId));

    conn.onClose(() => {
      log.info({ meetingId }, "MeetAudioIngest: bot connection closed");
    });

    conn.onError((err) => {
      log.warn({ err, meetingId }, "MeetAudioIngest: bot connection error");
    });
  }

  /**
   * Forward a single PCM chunk to the streaming transcriber and fan it
   * out to every subscriber. Extracted from the `onData` handler so the
   * handshake path can replay trailing bytes that arrived in the same
   * segment as the auth line without duplicating the forwarding logic.
   */
  private handlePcmChunk(chunk: Buffer, meetingId: string): void {
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
  }

  /**
   * Translate a streaming STT event into a TranscriptChunkEvent and
   * dispatch it through the session router. Errors, closes, and other
   * non-transcript events are ignored — the session manager owns the
   * provider's lifecycle, not the ingest.
   *
   * When diarization is enabled and the provider emits a `speakerLabel`,
   * forward it on the transcript chunk so {@link MeetSpeakerResolver}
   * can bind the opaque ASR label to a real participant identity.
   * `confidence` rides along when the provider surfaces it.
   * When `this.diarize` is false, `speakerLabel` is stripped even if
   * the provider happens to include one.
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

    const transcript: TranscriptChunkEvent = {
      type: "transcript.chunk",
      meetingId,
      timestamp: new Date().toISOString(),
      isFinal: event.type === "final",
      text: event.text,
      ...(this.diarize && event.speakerLabel !== undefined
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
// Handshake helpers
// ---------------------------------------------------------------------------

/**
 * Constant-time comparison of the presented token against the expected
 * token. Returns `false` whenever the lengths differ so a mismatched
 * length does not fall through to `timingSafeEqual` (which throws on
 * unequal buffer sizes).
 *
 * Both inputs are treated as UTF-8 — the token is hex-encoded in
 * practice, so UTF-8 and ASCII are identical.
 */
function constantTimeTokenEqual(
  presented: string,
  expected: string,
): boolean {
  if (presented.length !== expected.length) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Defaults — resolve the configured STT provider + real node:net socket
// ---------------------------------------------------------------------------

function formatDisjunction(items: readonly string[]): string {
  if (items.length === 0) return "a supported provider";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

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
    const streamingProviders = listProviderIds().filter((id) =>
      supportsBoundary(id, "daemon-streaming"),
    );
    const providerList = formatDisjunction(streamingProviders);
    throw new MeetAudioIngestError(
      "The configured STT provider is unusable for Meet transcription. " +
        `Set services.stt.provider to ${providerList} ` +
        "and ensure credentials are present.",
    );
  }
  return transcriber;
}

/**
 * Default audio-ingest listener — opens a `node:net` TCP server bound
 * per {@link AUDIO_INGEST_BIND_HOST} (all interfaces) with an
 * OS-assigned port. The port is read back from the server's address
 * once `listen()` resolves and exposed on the returned
 * {@link AudioIngestServer} so the session manager can thread it through
 * to the bot container as the `DAEMON_AUDIO_PORT` env var.
 */
function defaultListen(): Promise<AudioIngestServer> {
  return new Promise<AudioIngestServer>((resolve, reject) => {
    let settled = false;
    const connectionListeners: Array<(conn: AudioIngestConnection) => void> =
      [];
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

    netServer.listen({ host: AUDIO_INGEST_BIND_HOST, port: 0 }, () => {
      if (settled) return;
      settled = true;

      const address = netServer.address();
      if (!address || typeof address === "string") {
        // `netServer.address()` returns `null` only if the server is not
        // listening, and a `string` only for Unix-domain servers — neither
        // can occur after a successful TCP `listen()`. Guard anyway so a
        // future refactor that reintroduces Unix-domain listens (tests,
        // alternate transports) fails loudly instead of silently passing
        // `0` as the port.
        netServer.close();
        reject(
          new Error(
            `MeetAudioIngest: unexpected listen address shape: ${JSON.stringify(address)}`,
          ),
        );
        return;
      }
      const port = (address as AddressInfo).port;

      const wrapped: AudioIngestServer = {
        port,
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
 * {@link AudioIngestConnection} surface consumed by the ingest.
 */
function adaptNetSocket(socket: NetSocket): AudioIngestConnection {
  return {
    onData: (listener) => socket.on("data", listener),
    onClose: (listener) => socket.on("close", listener),
    onError: (listener) => socket.on("error", listener),
    destroy: () => socket.destroy(),
  };
}

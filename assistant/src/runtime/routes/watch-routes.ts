/**
 * The ingress for a watch session: `/v1/watch/stream`, a WebSocket carrying
 * the user's narration while they work.
 *
 * The transport is the one `/v1/stt/stream` already established, and
 * deliberately not a second story: binary frames or base64 `audio` events in,
 * a `{ type: "stop" }` text frame to flush, and a `StreamingTranscriber`
 * resolved by `resolveStreamingTranscriber()` so provider selection,
 * credentials, and language live in exactly one place. Watch is its own STT
 * consumer there (`services.stt.roles.watch`, falling back to the global
 * provider), because it shares dictation's transport without sharing its
 * batch fallback.
 *
 * What differs is everything downstream of a transcript. Dictation hands its
 * text back to the client; a watch session hands each final to
 * {@link WatchSessionManager}, which files it on the timeline and decides
 * whether the screen is worth reading. So the frames going the other way are
 * lifecycle only: `ready`, `entry`, `observation`, `error`, `closed`. No
 * `partial`, no transcript text, no assistant reply. What the client draws
 * during a session is that the session is running and that its screen was
 * read, never what was said or seen, and the assistant stays silent until the
 * retrospective, which is a conversational turn that happens after the socket
 * is gone.
 *
 * Route policy: the upgrade is gated exactly as `/v1/stt/stream` is, in
 * `http-server.ts`: private-network peer and origin, then an `svc_gateway`
 * service token. A WebSocket upgrade never reaches the shared `ROUTES` array,
 * whose `policy` block the HTTP adapter evaluates per JSON request, so the
 * gate is the upgrade handler's rather than a `RoutePolicy` value. The gateway
 * authenticates the downstream actor before it dials upstream
 * (`gateway/src/http/routes/stt-stream-websocket.ts` requires an actor
 * principal and refuses service tokens on the client-facing half).
 */

import type {
  StreamingTranscriber,
  SttErrorCategory,
  SttStreamServerEvent,
} from "../../stt/types.js";
import { getLogger } from "../../util/logger.js";
import { runWatchRetro } from "../../watch/watch-retro.js";
import {
  WatchSessionManager,
  type WatchSessionSummary,
} from "../../watch/watch-session-manager.js";

const log = getLogger("watch-stream");

/**
 * How long a socket may go without an inbound frame before the session is torn
 * down, matching `/v1/stt/stream`. A watch client streams capture continuously,
 * so silence on the socket means the client is gone rather than that the user
 * stopped talking, and a leaked session would hold the single manager slot
 * against the next press of Watch.
 */
const IDLE_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * Why a session ended badly. Provider failures keep the category
 * `resolveStreamingTranscriber`'s stack already assigns them; `session-error`
 * covers the reasons that are the watch session's own, such as a second socket
 * arriving while one is running.
 */
export type WatchStreamErrorCategory = SttErrorCategory | "session-error";

/**
 * What the daemon sends back. Lifecycle only.
 *
 * `entry` is an acknowledgement that narration reached the session, carrying
 * no text: it is what lets a client show that capture is live without drawing
 * a transcript nobody is meant to read mid-session.
 *
 * `observation` is the same acknowledgement for the other half of a session,
 * the screen reads the runtime takes around what the user says. It is a frame
 * of its own rather than a discriminator on `entry` because the two report
 * different facts with different failure modes: an `entry` is the narration
 * the client itself just streamed coming back confirmed, while an
 * `observation` is the only word a client ever gets that its screen was read
 * at all. A client that treated them as one kind would have to re-derive that
 * distinction from a field, and a client that knows nothing of the new frame
 * ignores it, which is what makes this additive.
 *
 * Both are discrete events rather than states, and neither is emitted on a
 * timer. A client can honestly draw the moment one arrives and nothing in
 * between, which is the whole of what a watch session gives it to draw: the
 * cadence is roughly three or four reads a minute (`MIN_OBSERVE_INTERVAL_MS`
 * to `MAX_OBSERVE_INTERVAL_MS` in `watch-session-manager.ts`), so a
 * client-side approximation of it would spend most of a session claiming a
 * capture that is not happening.
 */
export type WatchStreamServerFrame =
  | { readonly type: "ready"; sessionId: string; conversationId: string }
  | { readonly type: "entry" }
  | { readonly type: "observation" }
  | {
      readonly type: "error";
      category: WatchStreamErrorCategory;
      message: string;
    }
  | { readonly type: "closed" };

/**
 * Minimal socket surface, so the session can be driven by a test double
 * instead of Bun's `ServerWebSocket`.
 */
export interface WatchStreamSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

// ---------------------------------------------------------------------------
// Manager singleton
// ---------------------------------------------------------------------------

let sharedManager: WatchSessionManager | null = null;

/**
 * The process-wide watch session manager.
 *
 * One instance because the manager owns one slot: it is driven by the one
 * microphone the machine has, and a second manager would let two sessions
 * interleave unrelated timelines. Lazily created so importing this module
 * costs nothing until a socket arrives.
 */
export function getWatchSessionManager(): WatchSessionManager {
  sharedManager ??= new WatchSessionManager();
  return sharedManager;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

type SessionState =
  /** Constructed, waiting for the transcriber and the session slot. */
  | "initializing"
  /** Recording: audio frames are accepted and finals become narration. */
  | "active"
  /** The client sent `stop`; the provider is flushing its last finals. */
  | "stopping"
  /** Terminal. */
  | "closed";

export interface WatchStreamSessionOptions {
  /** MIME type of the audio the client streams. */
  readonly mimeType: string;
  /** Sample rate in Hz, threaded to the provider that wants one. */
  readonly sampleRate?: number;
  /** Adopt an existing conversation rather than minting one for the session. */
  readonly conversationId?: string;
  /** The desktop client to observe, when the actor has more than one. */
  readonly clientId?: string;
  /** Override the idle window for testing. */
  readonly idleTimeoutMs?: number;
  /** The manager the session drives. Defaults to the process-wide one. */
  readonly manager?: WatchSessionManager;
  /**
   * Opens the provider stream. Defaults to `resolveStreamingTranscriber`,
   * imported lazily so a caller that injects its own never pulls the provider
   * stack into the module graph.
   */
  readonly resolveTranscriber?: () => Promise<StreamingTranscriber | null>;
  /** Resolves the actor the session observes for. */
  readonly resolveActorPrincipalId?: () => Promise<string | undefined>;
  /**
   * Runs the end-of-session retrospective. Defaults to {@link runWatchRetro}.
   */
  readonly runRetro?: (summary: WatchSessionSummary) => Promise<unknown>;
}

/**
 * One watch session, from socket open to teardown.
 *
 * Created by the WebSocket `open` handler in `http-server.ts` and destroyed on
 * `stop`, client disconnect, idle timeout, or runtime shutdown. Whichever of
 * those arrives first, the manager slot is released exactly once.
 */
export class WatchStreamSession {
  private state: SessionState = "initializing";
  private transcriber: StreamingTranscriber | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Whether this socket is the one holding the manager's slot. A socket that
   * was turned away as busy must never stop the session that turned it away.
   */
  private ownsManagerSession = false;

  private readonly ws: WatchStreamSocket;
  private readonly options: WatchStreamSessionOptions;
  private readonly manager: WatchSessionManager;
  private readonly idleTimeoutMs: number;

  constructor(ws: WatchStreamSocket, options: WatchStreamSessionOptions) {
    this.ws = ws;
    this.options = options;
    this.manager = options.manager ?? getWatchSessionManager();
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  }

  /** Whether the session has reached its terminal state. */
  get isClosed(): boolean {
    return this.state === "closed";
  }

  // ── Startup ────────────────────────────────────────────────────────

  /**
   * Resolve the actor, open the provider stream, and claim the session slot.
   *
   * The actor comes first because it is the binding everything else depends
   * on: `observeHostScreen` reaches only that actor's own desktop clients, and
   * a session started without one could record nothing but failures. Failing
   * here sends `error` then `closed` rather than opening a session that cannot
   * see anything.
   */
  async start(): Promise<void> {
    if (this.state !== "initializing") {
      log.warn(
        { state: this.state },
        "Watch stream start in non-initial state",
      );
      return;
    }

    if (watchIngressClosed) {
      this.failStart(
        "session-error",
        "The assistant is shutting down and is not starting new watch sessions.",
        1001,
      );
      return;
    }

    try {
      const sourceActorPrincipalId = await this.resolveActorPrincipalId();
      if (this.isClosed) {
        return;
      }
      if (!sourceActorPrincipalId) {
        this.failStart(
          "session-error",
          "Watch could not resolve the actor to observe for. Sign in on this device and try again.",
          1008,
        );
        return;
      }

      const transcriber = await this.resolveTranscriber();

      // The socket can close while either resolution is in flight. Read the
      // terminal state through the getter so the compiler does not narrow it
      // to the value it held before the await.
      if (this.isClosed) {
        stopQuietly(transcriber);
        return;
      }

      if (!transcriber) {
        this.failStart(
          "provider-error",
          "Watch needs a speech provider that supports streaming transcription.",
          1000,
        );
        return;
      }

      this.transcriber = transcriber;
      await transcriber.start((event) => {
        this.handleTranscriberEvent(event);
      });

      if (this.isClosed) {
        stopQuietly(transcriber);
        this.transcriber = null;
        return;
      }

      const started = this.manager.start({
        sourceActorPrincipalId,
        onObservation: () => {
          this.handleObservation();
        },
        ...(this.options.conversationId
          ? { conversationId: this.options.conversationId }
          : {}),
        ...(this.options.clientId ? { clientId: this.options.clientId } : {}),
      });
      if (started.status !== "started") {
        this.failStart(
          "session-error",
          started.status === "busy"
            ? "A watch session is already running."
            : started.reason,
          1000,
        );
        return;
      }
      this.ownsManagerSession = true;

      this.state = "active";
      this.resetIdleTimer();
      this.sendFrame({
        type: "ready",
        sessionId: started.sessionId,
        conversationId: started.conversationId,
      });
      log.info(
        {
          sessionId: started.sessionId,
          conversationId: started.conversationId,
          provider: transcriber.providerId,
        },
        "Watch stream session started",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ error: message }, "Failed to start watch stream session");
      this.failStart("provider-error", message, 1011);
    }
  }

  // ── Inbound frames ─────────────────────────────────────────────────

  /** Handle a text frame: a base64 `audio` event or `stop`. */
  handleMessage(raw: string): void {
    if (this.state === "closed") {
      return;
    }
    this.resetIdleTimer();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.debug("Watch stream: dropped non-JSON text frame");
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      return;
    }

    const event = parsed as {
      type?: string;
      audio?: string;
      mimeType?: string;
    };
    switch (event.type) {
      case "audio": {
        if (this.state !== "active" || typeof event.audio !== "string") {
          return;
        }
        this.transcriber?.sendAudio(
          Buffer.from(event.audio, "base64"),
          event.mimeType ?? this.options.mimeType,
        );
        return;
      }
      case "stop": {
        this.handleStop();
        return;
      }
      default: {
        log.debug({ type: event.type }, "Watch stream: dropped unknown event");
        return;
      }
    }
  }

  /** Handle a binary frame: raw audio bytes. */
  handleBinaryAudio(data: Buffer | ArrayBuffer | Uint8Array): void {
    if (this.state !== "active") {
      return;
    }
    this.resetIdleTimer();

    const buffer = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    this.transcriber?.sendAudio(buffer, this.options.mimeType);
  }

  /** The client disconnected, or the transport failed. */
  handleClose(code: number, reason?: string): void {
    if (this.state === "closed") {
      return;
    }
    log.info({ code, reason }, "Watch stream WebSocket closed");
    this.teardown();
  }

  /**
   * Forcible teardown, for runtime shutdown.
   *
   * No retrospective. A retro is a full agent turn that runs for as long as the
   * model takes, and the process behind it is on its way out: started here it
   * would be killed partway through, leaving a half-written report in the
   * thread. Skipping keeps the timeline, which is the whole of what the
   * session recorded and outlives the daemon.
   */
  destroy(): void {
    if (this.state === "closed") {
      return;
    }
    log.info("Watch stream session destroyed");
    this.teardown({ retrospective: false });
  }

  // ── Internals ──────────────────────────────────────────────────────

  private async resolveActorPrincipalId(): Promise<string | undefined> {
    if (this.options.resolveActorPrincipalId) {
      return this.options.resolveActorPrincipalId();
    }
    return resolveWatchActorPrincipalId();
  }

  private async resolveTranscriber(): Promise<StreamingTranscriber | null> {
    if (this.options.resolveTranscriber) {
      return this.options.resolveTranscriber();
    }
    const { resolveStreamingTranscriber } =
      await import("../../providers/speech-to-text/resolve.js");
    return resolveStreamingTranscriber({
      role: "watch",
      ...(this.options.sampleRate !== undefined
        ? { sampleRate: this.options.sampleRate }
        : {}),
    });
  }

  /**
   * Report why the session never opened, then close. The teardown between the
   * two stops a transcriber that opened before the failing step, and emits the
   * terminal `closed` frame.
   */
  private failStart(
    category: WatchStreamErrorCategory,
    message: string,
    closeCode: number,
  ): void {
    this.sendFrame({ type: "error", category, message });
    this.teardown();
    this.closeSocket(closeCode, "watch session start failed");
  }

  /**
   * The client finished narrating. The provider may still emit finals after
   * `stop()`, so the session waits for the provider's `closed` rather than
   * tearing down here.
   */
  private handleStop(): void {
    if (this.state !== "active") {
      return;
    }
    this.state = "stopping";
    this.clearIdleTimer();

    try {
      this.transcriber?.stop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ error: message }, "Error stopping the watch transcriber");
      this.sendFrame({ type: "error", category: "provider-error", message });
      this.teardown();
      this.closeSocket(1011, "stop failed");
    }
  }

  /**
   * A screen read landed on the timeline, so tell the client.
   *
   * The manager only calls this for a read that came back and was kept, so
   * everything the session does with the news is send it: a failed, timed-out,
   * or cancelled read never reaches here (see `WatchSessionStartOptions`).
   *
   * The terminal check is the socket's own. A read dispatched moments before
   * teardown is dropped by the manager's `stopped` guard, so this is guarding
   * the narrower case of a listener that outlived the session it was passed
   * with, and it keeps the frame order the client's contract: nothing after
   * `closed`.
   */
  private handleObservation(): void {
    if (this.state === "closed") {
      return;
    }
    this.sendFrame({ type: "observation" });
  }

  private handleTranscriberEvent(event: SttStreamServerEvent): void {
    if (this.state === "closed") {
      return;
    }

    if (event.type === "turn-start") {
      // Onset, not text. Observing here catches the screen the user is about
      // to describe rather than the one their sentence left behind; the
      // narration itself is filed by the `final` below. Fire and forget for
      // the same reason as that one, and no `entry` frame is sent because no
      // narration was appended; the read this triggers announces itself
      // through `handleObservation` if it lands.
      void this.manager.handleNarrationStart().catch((err: unknown) => {
        log.warn({ err }, "Watch narration-start observation threw");
      });
      return;
    }

    if (event.type === "final") {
      const text = event.text.trim();
      if (!text) {
        return;
      }
      // Fire and forget: the narration is filed synchronously inside
      // `handleNarrationFinal`, and what remains is the screen read, which the
      // manager already owns the failure handling for.
      void this.manager.handleNarrationFinal(text).catch((err: unknown) => {
        log.warn({ err }, "Watch narration append threw");
      });
      this.sendFrame({ type: "entry" });
      return;
    }

    if (event.type === "error") {
      this.sendFrame({
        type: "error",
        category: event.category,
        message: event.message,
      });
      return;
    }

    if (event.type === "closed") {
      this.teardown();
      this.closeSocket(1000, "session complete");
    }
  }

  // ── Idle timer ─────────────────────────────────────────────────────

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    if (this.state === "closed" || this.state === "stopping") {
      return;
    }

    this.idleTimer = setTimeout(() => {
      if (this.state === "closed") {
        return;
      }
      log.warn("Watch stream session idle timeout");
      this.sendFrame({
        type: "error",
        category: "timeout",
        message: "The watch session timed out because the client went quiet.",
      });
      this.teardown();
      this.closeSocket(1000, "idle timeout");
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ── Teardown ───────────────────────────────────────────────────────

  /**
   * Release everything the session holds and send the terminal `closed` frame.
   * Idempotent: the close handler, the idle timer, and the provider's own
   * `closed` all land here, and only the first one does any work.
   */
  private teardown(
    options: { retrospective: boolean } = { retrospective: true },
  ): void {
    if (this.state === "closed") {
      return;
    }
    this.state = "closed";
    this.clearIdleTimer();

    if (this.transcriber) {
      stopQuietly(this.transcriber);
      this.transcriber = null;
    }

    if (this.ownsManagerSession) {
      this.ownsManagerSession = false;
      // A screen read still in flight is dropped by the manager's `stopped`
      // guard rather than awaited. Narration itself survives, because
      // `handleNarrationFinal` files it synchronously before it observes, so
      // what is lost is at most one trailing frame of a session that is over.
      const summary = this.manager.stop();
      if (summary) {
        log.info(
          {
            sessionId: summary.sessionId,
            conversationId: summary.conversationId,
            entryCount: summary.entryCount,
            durationMs: summary.durationMs,
          },
          "Watch session ended",
        );
        if (options.retrospective) {
          this.startRetrospective(summary);
        } else {
          log.info(
            { sessionId: summary.sessionId },
            "Watch session ended during shutdown; skipping the retrospective",
          );
        }
      }
    }

    this.sendFrame({ type: "closed" });
  }

  /**
   * Start the retrospective and register it so shutdown can wait on it.
   *
   * The turn is a conversation that outlives the socket by minutes, so
   * teardown starts it rather than blocking on it, and it owns its own
   * failures. Registration is what stops a stop-then-quit from killing a turn
   * mid-generation: {@link drainWatchRetros} gives one already in flight a
   * bounded chance to finish.
   */
  private startRetrospective(summary: WatchSessionSummary): void {
    const runRetro = this.options.runRetro ?? runWatchRetro;
    const pending = runRetro(summary).catch((err: unknown) => {
      log.warn(
        { err, sessionId: summary.sessionId },
        "Watch retrospective threw",
      );
    });
    inFlightWatchRetros.add(pending);
    void pending.finally(() => {
      inFlightWatchRetros.delete(pending);
    });
  }

  private sendFrame(frame: WatchStreamServerFrame): void {
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
      log.debug({ err }, "Watch stream: failed to send a frame");
    }
  }

  private closeSocket(code: number, reason: string): void {
    try {
      this.ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }
}

/** Stop a transcriber that may already be gone. */
function stopQuietly(transcriber: StreamingTranscriber | null): void {
  if (!transcriber) {
    return;
  }
  try {
    transcriber.stop();
  } catch {
    // Best effort.
  }
}

/**
 * The actor a watch session observes for: the vellum guardian bound to this
 * daemon, read from the gateway-owned binding.
 *
 * The principal comes from that binding rather than from anything the request
 * carries, because the request cannot carry a trustworthy one. The gateway
 * authenticates the downstream client's edge JWT and then dials the runtime on
 * a fresh socket bearing only its own service token
 * (`gateway/src/http/routes/stt-stream-websocket.ts`), so an actor claim on
 * the upgrade is never the gateway's word about who the client is. Honouring
 * one would let any caller holding the service token bind a session, and the
 * screen reads it drives, to somebody else's principal.
 *
 * It is the same binding `resolveActorPrincipalIdForLocalGuardian` falls
 * through to and the same one `live-voice-session.ts` stamps its turns with,
 * so a watch session observes the principal the host-proxy result routes match
 * a desktop client against.
 *
 * The read deliberately bypasses the guardian-delivery cache. That cache keeps
 * a successful read that found no binding, and a gateway-side binding write
 * does not invalidate it, so a guardian bound after the daemon cached an empty
 * answer would leave every Watch press failing the unresolvable-principal path
 * until the TTL lapsed. That is the order of events on a first run, and it
 * fails looking like a broken feature rather than one that is not ready yet. A
 * session starts only when a person asks for one, so a fresh read costs
 * nothing worth weighing against that.
 */
export async function resolveWatchActorPrincipalId(): Promise<
  string | undefined
> {
  const { findLocalGuardianPrincipalId } =
    await import("../local-actor-identity.js");
  return findLocalGuardianPrincipalId({ forceRefresh: true });
}

// ---------------------------------------------------------------------------
// Active session registry
// ---------------------------------------------------------------------------

/**
 * Open watch sessions keyed by socket session id, so runtime shutdown can tear
 * them all down deterministically. Mirrors `activeSttStreamSessions`.
 */
export const activeWatchStreamSessions = new Map<string, WatchStreamSession>();

/**
 * Retrospectives that have started and not yet settled.
 *
 * A retro is dispatched from a teardown that cannot wait on it, so without a
 * handle a socket closing seconds before shutdown leaves a turn running
 * against a database that is about to be closed underneath it.
 */
const inFlightWatchRetros = new Set<Promise<unknown>>();

/**
 * Whether new watch sessions are being refused.
 *
 * Shutdown tears down the sessions it can see and then waits on the
 * retrospectives they left running, and the Bun server keeps accepting
 * connections until well after both. Without this latch a socket that opens
 * and closes inside that window registers a retrospective nobody is waiting
 * on, which is the turn the drain exists to protect.
 *
 * A latch here rather than a shared one because the daemon has no shutdown
 * state a route can read: `shutdown-handlers.ts` keeps its flag module-private
 * and process-wide, and the readiness module tracks migrations rather than
 * teardown.
 */
let watchIngressClosed = false;

/**
 * Refuse new watch sessions, the first step of shutting the surface down.
 *
 * Separate from tearing the open sessions down so the order can be ingress
 * first, sessions second, retrospectives last. A session that arrives after
 * this fails its start with a clean error frame rather than opening and being
 * killed moments later.
 */
export function closeWatchIngress(): void {
  watchIngressClosed = true;
}

/** Accept watch sessions again. For tests, which share a module instance. */
export function reopenWatchIngressForTest(): void {
  watchIngressClosed = false;
}

/**
 * Longest shutdown waits for retrospectives already under way.
 *
 * Shutdown's other awaited step is releasing the live-voice session, which is
 * a handful of socket closes, so there is no established budget to borrow. A
 * retro is a model call and can legitimately take longer than any shutdown
 * should, which is why one is never started during shutdown; this bound is for
 * the turn that was already running when the user quit, and it is short enough
 * that quitting stays a quick action.
 */
const RETRO_DRAIN_TIMEOUT_MS = 5_000;

/**
 * Wait for in-flight retrospectives, up to {@link RETRO_DRAIN_TIMEOUT_MS}, and
 * report how many were still running when the wait ended.
 *
 * Resolves rather than rejects on the timeout: a retro that is still going is
 * a turn that will be cut off, which is worth a log line and never a reason to
 * fail the shutdown that is cutting it off. A settled one is forgotten, so the
 * registry tracks what is running rather than everything that ever ran.
 */
export async function drainWatchRetros(
  timeoutMs: number = RETRO_DRAIN_TIMEOUT_MS,
): Promise<number> {
  if (inFlightWatchRetros.size === 0) {
    return 0;
  }
  log.info(
    { count: inFlightWatchRetros.size },
    "Waiting for watch retrospectives to settle",
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([
    Promise.allSettled([...inFlightWatchRetros]).then(() => undefined),
    deadline,
  ]);
  clearTimeout(timer);
  const unsettled = inFlightWatchRetros.size;
  if (unsettled > 0) {
    log.warn(
      { count: unsettled },
      "Shutting down with watch retrospectives still running",
    );
  }
  return unsettled;
}

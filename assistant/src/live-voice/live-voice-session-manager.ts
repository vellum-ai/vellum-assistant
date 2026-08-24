import { randomUUID } from "node:crypto";

import {
  createLiveVoiceServerFrameSequencer,
  type LiveVoiceClientFrame,
  type LiveVoiceClientStartFrame,
  type LiveVoiceServerFrame,
  type LiveVoiceServerFramePayload,
} from "./protocol.js";

type MaybePromise<T> = T | Promise<T>;

export type LiveVoiceSessionCloseReason =
  | "client_end"
  | "error"
  | "websocket_close"
  | "transport_closed"
  | "client_timeout"
  | "forced_end"
  | "manager_shutdown";

/**
 * How long a session's own teardown may run before the manager stops waiting
 * on it and frees the slot anyway.
 *
 * `close()` is not a formality: it delivers a pending continuation into the
 * conversation, aborts an in-flight assistant turn, and flushes metrics — all
 * of which reach the network. Awaiting it unbounded is what turned a single
 * wedged teardown into a daemon that could never run live voice again, because
 * a closing session still reads as the active one to the busy check while
 * being un-releasable by any retry (LUM-3440).
 */
export const DEFAULT_LIVE_VOICE_CLOSE_TIMEOUT_MS = 10_000;

/**
 * How long a `server_vad` session may go without a single inbound frame
 * before the manager assumes its client is gone and releases the slot.
 *
 * The daemon's WebSocket peer is the gateway, not the client — a half-open
 * transport anywhere further out (a phone that left the network mid-call, a
 * dropped velay tunnel) delivers no close event here, so transport liveness
 * proves nothing about whether anyone is still on the call. Inbound frames do:
 * a `server_vad` client streams PCM continuously by construction (muted turns
 * send silence rather than nothing, so the server VAD is never starved), so a
 * full minute of wire silence means the client is gone, not quiet.
 */
export const DEFAULT_LIVE_VOICE_CLIENT_SILENCE_TIMEOUT_MS = 60_000;

export interface LiveVoiceSession {
  start(): MaybePromise<void>;
  handleClientFrame(frame: LiveVoiceClientFrame): MaybePromise<void>;
  handleBinaryAudio(chunk: Uint8Array): MaybePromise<void>;
  close(reason: LiveVoiceSessionCloseReason): MaybePromise<void>;
}

export interface LiveVoiceServerFrameSink {
  sendFrame(frame: LiveVoiceServerFrame): MaybePromise<void>;
  /**
   * Hang up the transport this session runs on. Optional, and called only
   * when the manager reclaims a slot on its own: reclaiming without hanging up
   * leaves a client streaming into a session that no longer exists, and leaves
   * every socket in the chain out to it open with nothing behind them.
   */
  closeTransport?(): void;
}

export interface LiveVoiceSessionFactoryContext {
  sessionId: string;
  startFrame: LiveVoiceClientStartFrame;
  sendFrame(frame: LiveVoiceServerFramePayload): Promise<LiveVoiceServerFrame>;
  /**
   * Releases this session's manager slot after a failure that happens once
   * `start()` has already resolved (e.g. the background STT arm failing
   * post-`ready`). Without it a failed session would hold the singleton
   * slot until the client closes the WebSocket.
   */
  releaseAfterFailure?(): Promise<void>;
}

export type LiveVoiceSessionFactory = (
  context: LiveVoiceSessionFactoryContext,
) => LiveVoiceSession;

/**
 * A slot the manager reclaimed on the session's behalf rather than at its
 * owner's request. Both mean a live voice session ended without anyone asking
 * it to, so both are worth a log line and a metric: they are the only evidence
 * that would explain a user who suddenly could not talk, and (for
 * `close_timed_out`) the only warning that a teardown path has started
 * hanging.
 */
export type LiveVoiceSlotEvent =
  | {
      kind: "close_timed_out";
      sessionId: string;
      reason: LiveVoiceSessionCloseReason;
      timeoutMs: number;
    }
  | {
      kind: "client_silence_timeout";
      sessionId: string;
      timeoutMs: number;
    };

export interface LiveVoiceSessionManagerOptions {
  createSession: LiveVoiceSessionFactory;
  createSessionId?: () => string;
  /** Overrides {@link DEFAULT_LIVE_VOICE_CLOSE_TIMEOUT_MS}; `0` disables. */
  closeTimeoutMs?: number;
  /**
   * Overrides {@link DEFAULT_LIVE_VOICE_CLIENT_SILENCE_TIMEOUT_MS}; `0`
   * disables the watchdog.
   */
  clientSilenceTimeoutMs?: number;
  /** Reports a slot the manager reclaimed itself. */
  onSlotEvent?: (event: LiveVoiceSlotEvent) => void;
}

export class LiveVoiceSessionStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveVoiceSessionStartupError";
  }
}

export type LiveVoiceStartSessionResult =
  | {
      status: "accepted";
      sessionId: string;
    }
  | {
      status: "failed";
      sessionId: string;
    }
  | {
      status: "busy";
      activeSessionId: string;
      frame: LiveVoiceServerFrame;
    };

export type LiveVoiceSessionDispatchResult =
  | {
      status: "handled";
      sessionId: string;
    }
  | {
      status: "not_found";
    };

export type LiveVoiceSessionReleaseResult =
  | {
      released: true;
      sessionId: string;
    }
  | {
      released: false;
    };

interface ActiveLiveVoiceSession {
  sessionId: string;
  session: LiveVoiceSession;
  sink: LiveVoiceServerFrameSink;
  closing: boolean;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  /** Resolves once this session has let go of the slot, however it went. */
  readonly released: Promise<void>;
  resolveReleased: () => void;
}

export class LiveVoiceSessionManager {
  private readonly createSession: LiveVoiceSessionFactory;
  private readonly createSessionId: () => string;
  private readonly closeTimeoutMs: number;
  private readonly clientSilenceTimeoutMs: number;
  private readonly onSlotEvent: (event: LiveVoiceSlotEvent) => void;
  private activeSession: ActiveLiveVoiceSession | null = null;

  constructor(options: LiveVoiceSessionManagerOptions) {
    this.createSession = options.createSession;
    this.createSessionId = options.createSessionId ?? randomUUID;
    this.closeTimeoutMs =
      options.closeTimeoutMs ?? DEFAULT_LIVE_VOICE_CLOSE_TIMEOUT_MS;
    this.clientSilenceTimeoutMs =
      options.clientSilenceTimeoutMs ??
      DEFAULT_LIVE_VOICE_CLIENT_SILENCE_TIMEOUT_MS;
    this.onSlotEvent = options.onSlotEvent ?? (() => {});
  }

  get activeSessionId(): string | null {
    return this.activeSession?.sessionId ?? null;
  }

  async startSession(
    startFrame: LiveVoiceClientStartFrame,
    sink: LiveVoiceServerFrameSink,
  ): Promise<LiveVoiceStartSessionResult> {
    // A slot that is already tearing down is not a reason to turn a client
    // away, it is a reason to wait: the client asking is usually the same one
    // whose transport just died, reconnecting a second or two later, and its
    // old session's close can easily outlast that gap (it delivers a pending
    // continuation and unwinds an in-flight turn). Answering `busy` there is
    // what turned a recoverable blip into "Another live-voice session is
    // active." with nothing behind it (LUM-3440). Waiting keeps the invariant
    // that matters — one session's audio devices are never live alongside the
    // next one's — and the wait is bounded by the close budget.
    const closingSession = this.activeSession?.closing
      ? this.activeSession
      : null;
    if (closingSession !== null) {
      await closingSession.released;
    }

    const existingSessionId = this.activeSessionId;
    if (existingSessionId !== null) {
      const busySequencer = createLiveVoiceServerFrameSequencer();
      const frame = busySequencer.next({
        type: "busy",
        activeSessionId: existingSessionId,
      });
      await sink.sendFrame(frame);
      return {
        status: "busy",
        activeSessionId: existingSessionId,
        frame,
      };
    }

    const sessionId = this.createSessionId();
    const sequencer = createLiveVoiceServerFrameSequencer();
    const context: LiveVoiceSessionFactoryContext = {
      sessionId,
      startFrame,
      sendFrame: async (payload) => {
        const frame = sequencer.next(payload);
        await sink.sendFrame(frame);
        return frame;
      },
      releaseAfterFailure: async () => {
        await this.releaseAfterSessionError(sessionId);
      },
    };
    const session = this.createSession(context);
    let resolveReleased = (): void => {};
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    const active: ActiveLiveVoiceSession = {
      sessionId,
      session,
      sink,
      closing: false,
      silenceTimer: null,
      released,
      resolveReleased,
    };
    this.activeSession = active;
    // Armed before `start()` rather than after it, so the watchdog also covers
    // a startup that hangs: a provider dial with no timeout of its own would
    // otherwise hold the slot with no session to release and no frame to
    // explain it. Nothing refreshes the deadline during startup — the
    // transport rejects client audio until `start` resolves — so the first
    // window is startup plus the client's first frame.
    this.armClientSilenceWatchdog(active, startFrame);

    try {
      await session.start();
    } catch (err) {
      await this.releaseAfterSessionError(sessionId);
      if (err instanceof LiveVoiceSessionStartupError) {
        return { status: "failed", sessionId };
      }
      throw err;
    }

    return { status: "accepted", sessionId };
  }

  async handleClientFrame(
    sessionId: string,
    frame: LiveVoiceClientFrame,
  ): Promise<LiveVoiceSessionDispatchResult> {
    const active = this.findActiveSession(sessionId);
    if (active === null) {
      return { status: "not_found" };
    }
    this.noteClientActivity(active);

    try {
      await active.session.handleClientFrame(frame);
    } catch (err) {
      await this.releaseAfterSessionError(sessionId);
      throw err;
    }

    if (frame.type === "end") {
      await this.releaseSession(sessionId, "client_end");
    }

    return { status: "handled", sessionId };
  }

  async handleBinaryAudio(
    sessionId: string,
    chunk: Uint8Array,
  ): Promise<LiveVoiceSessionDispatchResult> {
    const active = this.findActiveSession(sessionId);
    if (active === null) {
      return { status: "not_found" };
    }
    this.noteClientActivity(active);

    try {
      await active.session.handleBinaryAudio(chunk);
    } catch (err) {
      await this.releaseAfterSessionError(sessionId);
      throw err;
    }

    return { status: "handled", sessionId };
  }

  async releaseSession(
    sessionId: string,
    reason: LiveVoiceSessionCloseReason = "websocket_close",
  ): Promise<LiveVoiceSessionReleaseResult> {
    const active = this.findActiveSession(sessionId);
    if (active === null) {
      return { released: false };
    }

    active.closing = true;
    this.clearClientSilenceWatchdog(active);
    try {
      await this.closeWithinBudget(active, reason);
    } finally {
      if (this.activeSession === active) {
        this.activeSession = null;
      }
      active.resolveReleased();
    }
    return { released: true, sessionId };
  }

  /**
   * Release whatever session currently holds the slot, whoever owns it.
   *
   * The recovery path for a client that has no other way back: its own
   * transport is gone (so `end` cannot be sent) but the slot is still claimed,
   * which is the "Another live-voice session is active." dead end. Reports
   * `released: false` when nothing holds the slot, including when the holder
   * is already closing — that teardown frees the slot on its own budget.
   */
  async endActiveSession(
    reason: LiveVoiceSessionCloseReason = "forced_end",
  ): Promise<LiveVoiceSessionReleaseResult> {
    const sessionId = this.activeSessionId;
    if (sessionId === null) {
      return { released: false };
    }
    return await this.releaseSession(sessionId, reason);
  }

  /**
   * Whether the given session still holds the manager slot. Transports use
   * this to heal a stale per-connection binding: a session that failed
   * after `ready` releases its slot without any frame crossing the socket.
   */
  isSessionActive(sessionId: string): boolean {
    return this.findActiveSession(sessionId) !== null;
  }

  private findActiveSession(sessionId: string): ActiveLiveVoiceSession | null {
    const active = this.activeSession;
    if (active === null || active.sessionId !== sessionId || active.closing) {
      return null;
    }

    return active;
  }

  private async releaseAfterSessionError(sessionId: string): Promise<void> {
    try {
      await this.releaseSession(sessionId, "error");
    } catch {
      // The original session error is more useful to callers than a cleanup error.
    }
  }

  /**
   * Await the session's teardown, but only for as long as the close budget.
   *
   * A teardown that overruns is abandoned rather than cancelled: it keeps
   * unwinding in the background (the session has already marked itself closed,
   * so it cannot resurrect), while the caller — and the next client — stop
   * waiting on it. Freeing the slot early can leave the outgoing session's
   * providers briefly overlapping the next one's, which is a degraded call;
   * holding it forever is no call at all, ever again, until the daemon
   * restarts.
   */
  private async closeWithinBudget(
    active: ActiveLiveVoiceSession,
    reason: LiveVoiceSessionCloseReason,
  ): Promise<void> {
    const closed = Promise.resolve(active.session.close(reason));
    // The race below stops awaiting `closed` on a timeout, so anchor a handler
    // now: an abandoned teardown that rejects later must not surface as an
    // unhandled rejection.
    closed.catch(() => {});

    if (this.closeTimeoutMs <= 0) {
      await closed;
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), this.closeTimeoutMs);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([
        closed.then(() => "closed" as const),
        budget,
      ]);
      if (outcome === "timed_out") {
        this.onSlotEvent({
          kind: "close_timed_out",
          sessionId: active.sessionId,
          reason,
          timeoutMs: this.closeTimeoutMs,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Start the client-silence watchdog for a session whose mode guarantees a
   * continuous inbound stream. A `manual` session legitimately sits idle
   * between push-to-talk segments, so wire silence says nothing about its
   * client and it gets no watchdog.
   */
  private armClientSilenceWatchdog(
    active: ActiveLiveVoiceSession,
    startFrame: LiveVoiceClientStartFrame,
  ): void {
    if (
      this.clientSilenceTimeoutMs <= 0 ||
      startFrame.turnDetection !== "server_vad"
    ) {
      return;
    }
    this.scheduleClientSilenceWatchdog(active);
  }

  private scheduleClientSilenceWatchdog(active: ActiveLiveVoiceSession): void {
    const timer = setTimeout(() => {
      active.silenceTimer = null;
      if (this.activeSession !== active || active.closing) {
        return;
      }
      this.onSlotEvent({
        kind: "client_silence_timeout",
        sessionId: active.sessionId,
        timeoutMs: this.clientSilenceTimeoutMs,
      });
      try {
        active.sink.closeTransport?.();
      } catch {
        // A transport that cannot be closed is exactly the case the watchdog
        // exists for; reclaiming the slot still has to happen.
      }
      void this.releaseSession(active.sessionId, "client_timeout").catch(() => {
        // Best-effort reclamation; the slot is dropped either way.
      });
    }, this.clientSilenceTimeoutMs);
    timer.unref?.();
    active.silenceTimer = timer;
  }

  /** Push the watchdog deadline out — the client is demonstrably still there. */
  private noteClientActivity(active: ActiveLiveVoiceSession): void {
    if (active.silenceTimer === null) {
      return;
    }
    clearTimeout(active.silenceTimer);
    this.scheduleClientSilenceWatchdog(active);
  }

  private clearClientSilenceWatchdog(active: ActiveLiveVoiceSession): void {
    if (active.silenceTimer !== null) {
      clearTimeout(active.silenceTimer);
      active.silenceTimer = null;
    }
  }
}

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
  | "manager_shutdown";

export interface LiveVoiceSession {
  start(): MaybePromise<void>;
  handleClientFrame(frame: LiveVoiceClientFrame): MaybePromise<void>;
  handleBinaryAudio(chunk: Uint8Array): MaybePromise<void>;
  close(reason: LiveVoiceSessionCloseReason): MaybePromise<void>;
}

export interface LiveVoiceServerFrameSink {
  sendFrame(frame: LiveVoiceServerFrame): MaybePromise<void>;
  /**
   * Invoked once a session under this sink has fully closed and its
   * manager slot is released — including server-initiated ends ([END_CALL],
   * max session duration) where no client/socket event triggered the close.
   * The socket owner should detach and close the connection; this must be
   * idempotent for owner-initiated closes where the socket is already gone.
   */
  onSessionEnded?(sessionId: string): void;
}

export interface LiveVoiceSessionFactoryContext {
  sessionId: string;
  startFrame: LiveVoiceClientStartFrame;
  sendFrame(frame: LiveVoiceServerFramePayload): Promise<LiveVoiceServerFrame>;
  /**
   * Owner-release hook: the session calls this once when it has finished
   * closing, so the owner (manager) can drop its active-session slot even
   * when the close was session-initiated rather than owner-initiated.
   */
  onSessionEnded?(): void;
}

export type LiveVoiceSessionFactory = (
  context: LiveVoiceSessionFactoryContext,
) => LiveVoiceSession;

export interface LiveVoiceSessionManagerOptions {
  createSession: LiveVoiceSessionFactory;
  createSessionId?: () => string;
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
  closing: boolean;
}

export class LiveVoiceSessionManager {
  private readonly createSession: LiveVoiceSessionFactory;
  private readonly createSessionId: () => string;
  private activeSession: ActiveLiveVoiceSession | null = null;

  constructor(options: LiveVoiceSessionManagerOptions) {
    this.createSession = options.createSession;
    this.createSessionId = options.createSessionId ?? randomUUID;
  }

  get activeSessionId(): string | null {
    return this.activeSession?.sessionId ?? null;
  }

  async startSession(
    startFrame: LiveVoiceClientStartFrame,
    sink: LiveVoiceServerFrameSink,
  ): Promise<LiveVoiceStartSessionResult> {
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
      onSessionEnded: () => {
        if (this.activeSession?.sessionId === sessionId) {
          this.activeSession = null;
        }
        sink.onSessionEnded?.(sessionId);
      },
    };
    const session = this.createSession(context);
    this.activeSession = { sessionId, session, closing: false };

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
    try {
      await active.session.close(reason);
    } finally {
      if (this.activeSession === active) {
        this.activeSession = null;
      }
    }
    return { released: true, sessionId };
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
}

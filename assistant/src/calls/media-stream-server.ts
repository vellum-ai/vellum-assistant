/**
 * Media-stream call server: binds WebSocket lifecycle to call-session
 * lifecycle and wires STT session callbacks to controller entry points.
 *
 * Each active media-stream call has a single `MediaStreamCallSession`
 * instance that:
 *
 * 1. Owns a {@link MediaStreamSttSession} for ingesting raw audio and
 *    producing transcripts.
 * 2. Owns a {@link MediaStreamOutput} for sending synthesized audio
 *    and lifecycle signals back to Twilio.
 * 3. Creates and registers a {@link CallController} to process
 *    transcripts through the conversation pipeline.
 *
 * The server is registered on `/v1/calls/media-stream` but is **not**
 * reachable from production TwiML — the Twilio voice webhook and
 * relay setup router continue to use ConversationRelay exclusively.
 * This module exists as a dark path for integration testing only.
 *
 * Lifecycle:
 * - WebSocket `open` -> extract callSessionId from upgrade params,
 *   create `MediaStreamCallSession`.
 * - Media stream `start` event -> capture streamSid/callSid, wire
 *   output adapter, create controller.
 * - Media stream `media` events -> forwarded to STT session for
 *   turn detection and transcription.
 * - STT `onTranscriptFinal` -> routed to controller's
 *   `handleCallerUtterance()`.
 * - STT `onSpeechStart` -> (future) barge-in detection.
 * - Media stream `stop` event / WebSocket close -> finalize call.
 */

import type { ServerWebSocket } from "bun";

import { revokeScopedApprovalGrantsForContext } from "../memory/scoped-approval-grants.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { getLogger } from "../util/logger.js";
import { CallController } from "./call-controller.js";
import { addPointerMessage, formatDuration } from "./call-pointer-messages.js";
import {
  fireCallTranscriptNotifier,
  registerCallController,
  unregisterCallController,
} from "./call-state.js";
import { isTerminalState } from "./call-state-machine.js";
import {
  getCallSession,
  recordCallEvent,
  updateCallSession,
} from "./call-store.js";
import { finalizeCall } from "./finalize-call.js";
import { MediaStreamOutput } from "./media-stream-output.js";
import { parseMediaStreamFrame } from "./media-stream-parser.js";
import {
  MediaStreamSttSession,
  type MediaStreamSttSessionCallbacks,
  type MediaStreamSttSessionConfig,
} from "./media-stream-stt-session.js";

const log = getLogger("media-stream-server");

// ---------------------------------------------------------------------------
// Active sessions registry (keyed by callSessionId)
// ---------------------------------------------------------------------------

/**
 * Active media-stream call sessions keyed by callSessionId.
 *
 * Exported for use in `call-domain.ts` (cancel call cleanup) and for
 * test assertions. Not intended for general consumption.
 */
export const activeMediaStreamSessions = new Map<
  string,
  MediaStreamCallSession
>();

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class MediaStreamCallSession {
  readonly callSessionId: string;
  private output: MediaStreamOutput;
  private sttSession: MediaStreamSttSession;
  private controller: CallController | null = null;
  private streamSid: string | null = null;
  private callSid: string | null = null;
  private disposed = false;

  constructor(
    ws: ServerWebSocket<unknown>,
    callSessionId: string,
    sttConfig?: MediaStreamSttSessionConfig,
  ) {
    this.callSessionId = callSessionId;

    // Create output adapter with a placeholder streamSid — it will be
    // set when the `start` event arrives.
    this.output = new MediaStreamOutput(ws, "");

    // Create STT session with callbacks wired to the controller.
    const callbacks: MediaStreamSttSessionCallbacks = {
      onSpeechStart: () => this.handleSpeechStart(),
      onTranscriptFinal: (text, durationMs) =>
        this.handleTranscriptFinal(text, durationMs),
      onDtmf: (digit) => this.handleDtmf(digit),
      onStop: () => this.handleStreamStop(),
      onError: (category, message) => this.handleSttError(category, message),
    };

    this.sttSession = new MediaStreamSttSession(sttConfig ?? {}, callbacks);

    log.info({ callSessionId }, "Media stream call session created");
  }

  /**
   * Get the output adapter (for test assertions).
   */
  getOutput(): MediaStreamOutput {
    return this.output;
  }

  /**
   * Get the controller (for test assertions).
   */
  getController(): CallController | null {
    return this.controller;
  }

  /**
   * Feed a raw WebSocket message into the session.
   *
   * The message is parsed to intercept `start` events (for session
   * bootstrapping) before being forwarded to the STT session for
   * audio processing.
   */
  handleMessage(raw: string): void {
    if (this.disposed) return;

    // Intercept `start` to bootstrap the session before forwarding.
    const parseResult = parseMediaStreamFrame(raw);
    if (parseResult.ok && parseResult.event.event === "start") {
      this.handleStart(parseResult.event);
    }

    // Always forward to the STT session (it handles all event types).
    this.sttSession.handleMessage(raw);
  }

  /**
   * Handle WebSocket close. Finalizes the call session if not already
   * in a terminal state.
   */
  handleTransportClosed(code?: number, reason?: string): void {
    if (this.disposed) return;

    const session = getCallSession(this.callSessionId);
    if (!session) return;
    if (isTerminalState(session.status)) return;

    const isNormalClose = code === 1000;
    if (isNormalClose) {
      updateCallSession(this.callSessionId, {
        status: "completed",
        endedAt: Date.now(),
      });
      recordCallEvent(this.callSessionId, "call_ended", {
        reason: reason || "media_stream_closed",
        closeCode: code,
      });

      if (session.initiatedFromConversationId) {
        const durationMs = session.startedAt
          ? Date.now() - session.startedAt
          : 0;
        addPointerMessage(
          session.initiatedFromConversationId,
          "completed",
          session.toNumber,
          {
            duration: durationMs > 0 ? formatDuration(durationMs) : undefined,
          },
        ).catch((err) => {
          log.warn(
            { conversationId: session.initiatedFromConversationId, err },
            "Skipping pointer write — origin conversation may no longer exist",
          );
        });
      }
    } else {
      const detail =
        reason ||
        (code ? `media_stream_closed_${code}` : "media_stream_closed_abnormal");
      updateCallSession(this.callSessionId, {
        status: "failed",
        endedAt: Date.now(),
        lastError: `Media stream WebSocket closed unexpectedly: ${detail}`,
      });
      recordCallEvent(this.callSessionId, "call_failed", {
        reason: detail,
        closeCode: code,
      });

      if (session.initiatedFromConversationId) {
        addPointerMessage(
          session.initiatedFromConversationId,
          "failed",
          session.toNumber,
          { reason: detail },
        ).catch((err) => {
          log.warn(
            { conversationId: session.initiatedFromConversationId, err },
            "Skipping pointer write — origin conversation may no longer exist",
          );
        });
      }
    }

    // Revoke any scoped approval grants bound to this call session.
    // Revoke by both callSessionId and conversationId because the
    // guardian-approval-interception minting path sets callSessionId: null
    // but always sets conversationId.
    try {
      revokeScopedApprovalGrantsForContext({
        callSessionId: this.callSessionId,
      });
      revokeScopedApprovalGrantsForContext({
        conversationId: session.conversationId,
      });
    } catch (err) {
      log.warn(
        { err, callSessionId: this.callSessionId },
        "Failed to revoke scoped grants on media-stream transport close",
      );
    }

    finalizeCall(this.callSessionId, session.conversationId);
  }

  /**
   * Dispose of the session, cleaning up all resources.
   */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.sttSession.dispose();

    if (this.controller) {
      this.controller.destroy();
      unregisterCallController(this.callSessionId);
      this.controller = null;
    }

    this.output.markClosed();

    log.info(
      { callSessionId: this.callSessionId },
      "Media stream call session destroyed",
    );
  }

  // ── Internal: media-stream event handlers ─────────────────────────

  private handleStart(
    event: import("./media-stream-protocol.js").MediaStreamStartEvent,
  ): void {
    this.streamSid = event.streamSid;
    this.callSid = event.start.callSid;

    // Update the output adapter with the real streamSid.
    this.output.setStreamSid(event.streamSid);

    // Update the call session with the provider call SID.
    const session = getCallSession(this.callSessionId);
    if (session) {
      const updates: Parameters<typeof updateCallSession>[1] = {
        providerCallSid: event.start.callSid,
      };
      if (
        !isTerminalState(session.status) &&
        session.status !== "in_progress" &&
        session.status !== "waiting_on_user"
      ) {
        updates.status = "in_progress";
        if (!session.startedAt) updates.startedAt = Date.now();
      }
      updateCallSession(this.callSessionId, updates);
    }

    recordCallEvent(this.callSessionId, "call_connected", {
      callSid: event.start.callSid,
      streamSid: event.streamSid,
      encoding: event.start.mediaFormat.encoding,
      sampleRate: event.start.mediaFormat.sampleRate,
      transport: "media-stream",
    });

    // Create the call controller bound to the media-stream output.
    this.controller = new CallController(
      this.callSessionId,
      this.output,
      session?.task ?? null,
      {
        assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
      },
    );
    registerCallController(this.callSessionId, this.controller);

    log.info(
      {
        callSessionId: this.callSessionId,
        streamSid: this.streamSid,
        callSid: this.callSid,
      },
      "Media stream session started — controller registered",
    );

    // Fire the initial greeting.
    this.controller.startInitialGreeting().catch((err) => {
      log.error(
        { err, callSessionId: this.callSessionId },
        "Failed to start initial greeting on media-stream session",
      );
    });
  }

  // ── STT callbacks ─────────────────────────────────────────────────

  private handleSpeechStart(): void {
    // Future: barge-in detection — clear queued outbound audio when
    // the caller starts speaking.
    if (this.output && this.controller) {
      this.output.clearAudio();
    }
  }

  private handleTranscriptFinal(text: string, _durationMs: number): void {
    if (!text.trim()) return;
    if (!this.controller) {
      log.warn(
        { callSessionId: this.callSessionId },
        "Transcript received but no controller — dropping",
      );
      return;
    }

    const session = getCallSession(this.callSessionId);
    if (session) {
      fireCallTranscriptNotifier(
        session.conversationId,
        this.callSessionId,
        "caller",
        text,
      );
    }

    recordCallEvent(this.callSessionId, "caller_spoke", {
      transcript: text,
      transport: "media-stream",
    });

    // Route to the controller for conversation-backed response.
    this.controller.handleCallerUtterance(text).catch((err) => {
      log.error(
        { err, callSessionId: this.callSessionId },
        "Controller failed to handle caller utterance",
      );
    });
  }

  private handleDtmf(digit: string): void {
    log.info(
      { callSessionId: this.callSessionId, digit },
      "DTMF digit received on media-stream",
    );
    recordCallEvent(this.callSessionId, "caller_spoke", {
      dtmfDigit: digit,
      transport: "media-stream",
    });
  }

  private handleStreamStop(): void {
    log.info(
      { callSessionId: this.callSessionId },
      "Media stream stop event received",
    );
    // The WebSocket close handler will finalize the call session.
  }

  private handleSttError(category: string, message: string): void {
    log.error(
      { callSessionId: this.callSessionId, category, message },
      "STT error on media-stream session",
    );
    recordCallEvent(this.callSessionId, "call_failed", {
      reason: `STT error: ${category} — ${message}`,
      transport: "media-stream",
    });
  }
}

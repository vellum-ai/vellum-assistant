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
 * The server is registered on `/v1/calls/media-stream` and provides
 * full bidirectional call support: inbound audio is transcribed via
 * STT and outbound assistant speech is synthesized via TTS and
 * streamed as media frames back to Twilio.
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
 * - STT `onSpeechStart` -> barge-in: clears outbound audio queue
 *   and interrupts the in-flight LLM turn via the controller.
 * - Media stream `stop` event / WebSocket close -> finalize call.
 */

import type { ServerWebSocket } from "bun";

import { revokeScopedApprovalGrantsForContext } from "../memory/scoped-approval-grants.js";
import { toTrustContext } from "../runtime/actor-trust-resolver.js";
import { getLogger } from "../util/logger.js";
import { CallController } from "./call-controller.js";
import { addPointerMessage, formatDuration } from "./call-pointer-messages.js";
import { speakSystemPrompt } from "./call-speech-output.js";
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
import { routeSetup } from "./relay-setup-router.js";

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

  // ── Operational diagnostics counters ──────────────────────────────
  /** Number of barge-in attempts that were accepted (assistant was speaking). */
  private bargeInAccepted = 0;
  /** Number of barge-in attempts that were ignored (assistant not speaking). */
  private bargeInIgnored = 0;
  /** Number of turn-start transitions detected by the STT session. */
  private turnStarts = 0;
  /** Number of transcript finals produced (non-empty). */
  private transcriptFinalsProduced = 0;

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
    const terminationReason = isNormalClose ? "normal_stop" : "premature_abort";
    log.info(
      {
        callSessionId: this.callSessionId,
        terminationReason,
        closeCode: code,
        closeReason: reason,
        turnStarts: this.turnStarts,
        transcriptFinalsProduced: this.transcriptFinalsProduced,
        bargeInAccepted: this.bargeInAccepted,
        bargeInIgnored: this.bargeInIgnored,
      },
      "Media stream transport closed — session diagnostics",
    );
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
      {
        callSessionId: this.callSessionId,
        turnStarts: this.turnStarts,
        transcriptFinalsProduced: this.transcriptFinalsProduced,
        bargeInAccepted: this.bargeInAccepted,
        bargeInIgnored: this.bargeInIgnored,
      },
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

    // ── Setup-policy routing ────────────────────────────────────────
    // Run the same routeSetup() that the ConversationRelay path uses
    // to enforce ACL/deny/escalate, verification, and invite flows.
    // The media-stream transport does not support interactive sub-flows
    // (DTMF entry, name capture, guardian wait), so non-normal outcomes
    // are rejected gracefully with a TTS message and session teardown.
    const from = session?.fromNumber ?? "";
    const to = session?.toNumber ?? "";

    const { outcome, resolved } = routeSetup({
      callSessionId: this.callSessionId,
      session: session ?? null,
      from,
      to,
      customParameters: event.start.customParameters,
    });

    log.info(
      {
        callSessionId: this.callSessionId,
        streamSid: this.streamSid,
        callSid: this.callSid,
        setupAction: outcome.action,
      },
      "Media stream session started",
    );

    switch (outcome.action) {
      case "normal_call": {
        // Create the call controller only for normal calls. Deny and
        // unsupported-flow paths speak a message via the output adapter
        // directly and don't need a controller. Creating it eagerly
        // would start duration/silence timers that leak when the
        // session is torn down before destroy() runs.
        const initialTrustContext = toTrustContext(
          resolved.actorTrust,
          resolved.otherPartyNumber,
        );
        this.controller = new CallController(
          this.callSessionId,
          this.output,
          session?.task ?? null,
          {
            assistantId: resolved.assistantId,
            trustContext: initialTrustContext,
          },
        );
        registerCallController(this.callSessionId, this.controller);

        // Fire the initial greeting.
        this.controller.startInitialGreeting().catch((err) => {
          log.error(
            { err, callSessionId: this.callSessionId },
            "Failed to start initial greeting on media-stream session",
          );
        });
        return;
      }

      case "deny":
        // Deny — speak the denial message and tear down.
        log.warn(
          {
            callSessionId: this.callSessionId,
            reason: outcome.logReason,
          },
          "Media-stream setup denied by ACL policy",
        );
        recordCallEvent(this.callSessionId, "inbound_acl_denied", {
          from,
          trustClass: resolved.actorTrust.trustClass,
        });
        updateCallSession(this.callSessionId, {
          status: "failed",
          endedAt: Date.now(),
          lastError: outcome.logReason,
        });
        // Run finalization now because handleTransportClosed will see
        // terminal status and exit early when the WebSocket closes.
        this.runFinalizationAndGrantCleanup(session);
        void speakSystemPrompt(this.output, outcome.message).finally(() => {
          setTimeout(() => this.output.endSession(outcome.logReason), 3000);
        });
        return;

      default:
        // All interactive sub-flows (verification, invite_redemption,
        // name_capture, callee_verification, outbound_verification) are
        // not supported on the media-stream transport. The TwiML preflight
        // in twilio-routes.ts should have caught this and fallen back to
        // ConversationRelay — reaching here indicates the preflight was
        // bypassed or a new setup action was added without updating the
        // preflight guard. Speak a generic apology and end the session
        // rather than silently bypassing policy enforcement.
        log.error(
          {
            callSessionId: this.callSessionId,
            action: outcome.action,
          },
          "Media-stream transport received unsupported setup flow — preflight guard should have prevented this",
        );
        recordCallEvent(this.callSessionId, "call_failed", {
          reason: `Setup flow '${outcome.action}' not supported on media-stream transport (preflight guard bypass)`,
          transport: "media-stream",
        });
        updateCallSession(this.callSessionId, {
          status: "failed",
          endedAt: Date.now(),
          lastError: `Setup flow '${outcome.action}' not supported on media-stream transport — preflight guard should have prevented this`,
        });
        // Run finalization now because handleTransportClosed will see
        // terminal status and exit early when the WebSocket closes.
        this.runFinalizationAndGrantCleanup(session);
        void speakSystemPrompt(
          this.output,
          "Sorry, this call requires additional verification that isn't available right now. Please try calling back. Goodbye.",
        ).finally(() => {
          setTimeout(
            () =>
              this.output.endSession(
                `Unsupported setup flow: ${outcome.action} (preflight guard bypass)`,
              ),
            3000,
          );
        });
        return;
    }
  }

  // ── Finalization helper for early-teardown paths ─────────────────

  /**
   * Run scoped-grant revocation and call finalization inline. Used by
   * the deny and unsupported-flow branches which set terminal status
   * before `endSession()`. When the WebSocket subsequently closes,
   * {@link handleTransportClosed} sees the terminal status and exits
   * early — so we must perform cleanup here to avoid leaking grants
   * and skipping `finalizeCall()` side-effects.
   */
  private runFinalizationAndGrantCleanup(
    session: ReturnType<typeof getCallSession>,
  ): void {
    try {
      revokeScopedApprovalGrantsForContext({
        callSessionId: this.callSessionId,
      });
      if (session?.conversationId) {
        revokeScopedApprovalGrantsForContext({
          conversationId: session.conversationId,
        });
      }
    } catch (err) {
      log.warn(
        { err, callSessionId: this.callSessionId },
        "Failed to revoke scoped grants on early teardown path",
      );
    }

    if (session?.conversationId) {
      finalizeCall(this.callSessionId, session.conversationId);
    }
  }

  // ── STT callbacks ─────────────────────────────────────────────────

  private handleSpeechStart(): void {
    this.turnStarts++;

    // Barge-in: clear queued outbound audio and abort the in-flight LLM
    // turn only when the assistant is actively speaking. Uses the gated
    // handleBargeIn path so initial inbound audio frames do not cancel a
    // still-starting initial turn.
    //
    // clearAudio runs BEFORE handleBargeIn so that the end-of-turn mark
    // enqueued by handleInterrupt (called within handleBargeIn) is not
    // wiped by the queue flush.
    if (this.output && this.controller) {
      this.output.clearAudio();
      const accepted = this.controller.handleBargeIn();
      if (accepted) {
        this.bargeInAccepted++;
        log.info(
          { callSessionId: this.callSessionId },
          "Media-stream barge-in accepted — cleared outbound audio",
        );
      } else {
        this.bargeInIgnored++;
        log.debug(
          { callSessionId: this.callSessionId },
          "Media-stream barge-in ignored — assistant not speaking",
        );
      }
    }
  }

  private handleTranscriptFinal(text: string, _durationMs: number): void {
    if (!text.trim()) return;
    this.transcriptFinalsProduced++;

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

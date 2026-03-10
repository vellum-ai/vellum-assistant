/**
 * Session-backed voice call controller.
 *
 * Routes voice turns through the daemon session pipeline via
 * voice-session-bridge instead of calling provider.sendMessage() directly.
 * This gives voice calls access to tools, memory, skills, and runtime
 * injections while preserving all existing call UX behavior (control markers,
 * barge-in, state machine, guardian verification).
 */

import { getGatewayInternalBaseUrl } from "../config/env.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { TrustContext } from "../daemon/session-runtime-assembly.js";
import {
  expireCanonicalGuardianRequest,
  getCanonicalRequestByPendingQuestionId,
  getPendingCanonicalRequestByCallSessionId,
  listCanonicalGuardianDeliveries,
} from "../memory/canonical-guardian-store.js";
import { revokeScopedApprovalGrantsForContext } from "../memory/scoped-approval-grants.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { mintDaemonDeliveryToken } from "../runtime/auth/token-service.js";
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";
import { getLogger } from "../util/logger.js";
import {
  getMaxCallDurationMs,
  getSilenceTimeoutMs,
  getUserConsultationTimeoutMs,
} from "./call-constants.js";
import { addPointerMessage, formatDuration } from "./call-pointer-messages.js";
import {
  fireCallQuestionNotifier,
  fireCallTranscriptNotifier,
  registerCallController,
  unregisterCallController,
} from "./call-state.js";
import {
  createPendingQuestion,
  expirePendingQuestions,
  getCallSession,
  recordCallEvent,
  updateCallSession,
} from "./call-store.js";
import { finalizeCall } from "./finalize-call.js";
import { sendGuardianExpiryNotices } from "./guardian-action-sweep.js";
import { dispatchGuardianQuestion } from "./guardian-dispatch.js";
import type { RelayConnection } from "./relay-server.js";
import type { PromptSpeakerContext } from "./speaker-identification.js";
import {
  ASK_GUARDIAN_CAPTURE_REGEX,
  CALL_OPENING_ACK_MARKER,
  CALL_OPENING_MARKER,
  couldBeControlMarker,
  END_CALL_MARKER,
  extractBalancedJson,
  stripInternalSpeechMarkers,
} from "./voice-control-protocol.js";
import {
  startVoiceTurn,
  type VoiceTurnHandle,
} from "./voice-session-bridge.js";

const log = getLogger("call-controller");

type ControllerState = "idle" | "processing" | "speaking";

/**
 * Tracks a pending guardian input request independently of the controller's
 * turn state. This allows the call to continue normal turn processing
 * (idle -> processing -> speaking) while a guardian consultation is outstanding.
 * Also used to suppress the silence nudge ("Are you still there?") while
 * the caller is waiting on a guardian decision.
 */
interface PendingGuardianInput {
  questionText: string;
  questionId: string;
  toolApprovalMeta: { toolName: string; inputDigest: string } | null;
  timer: ReturnType<typeof setTimeout>;
}

export class CallController {
  private callSessionId: string;
  private relay: RelayConnection;
  private state: ControllerState = "idle";
  private abortController: AbortController = new AbortController();
  private currentTurnHandle: VoiceTurnHandle | null = null;
  private currentTurnPromise: Promise<void> | null = null;
  private destroyed = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private durationWarningTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Tracks the currently pending guardian input request, if any. Decoupled
   * from the controller's turn state so callers can continue to trigger
   * normal turns while a guardian consultation is outstanding. Also
   * suppresses the silence nudge while non-null.
   */
  private pendingGuardianInput: PendingGuardianInput | null = null;
  private durationEndTimer: ReturnType<typeof setTimeout> | null = null;
  private task: string | null;
  /** True when the call session was created via the inbound path (no outbound task). */
  private isInbound: boolean;
  /** Instructions queued while an LLM turn is in-flight or during pending guardian input */
  private pendingInstructions: string[] = [];
  /** Ensures the call opener is triggered at most once per call. */
  private initialGreetingStarted = false;
  /** Marks that the next caller turn should be treated as an opening acknowledgment. */
  private awaitingOpeningAck = false;
  /** Monotonic run id used to suppress stale turn side effects after interruption. */
  private llmRunVersion = 0;
  /** Optional broadcast function for emitting events to connected clients. */
  private broadcast?: (msg: ServerMessage) => void;
  /** Assistant identity for scoping guardian bindings. */
  private assistantId: string;
  /** Guardian trust context for the current caller, when available. */
  private trustContext: TrustContext | null;
  /** Conversation ID for the voice session. */
  private conversationId: string;
  /**
   * Track whether the last message sent to the session was a user message
   * whose assistant response has not yet been received. This is used to
   * prevent sending consecutive user messages that would violate role
   * alternation in the underlying session pipeline.
   */
  private lastSentWasOpener = false;
  /**
   * Set to true after a guardian consultation timeout occurs in this call.
   * Subsequent ASK_GUARDIAN attempts skip the full wait and immediately
   * inject a guardian-unavailable instruction so the model can adapt
   * without blocking the caller.
   */
  private guardianUnavailableForCall = false;

  constructor(
    callSessionId: string,
    relay: RelayConnection,
    task: string | null,
    opts?: {
      broadcast?: (msg: ServerMessage) => void;
      assistantId?: string;
      trustContext?: TrustContext;
    },
  ) {
    this.callSessionId = callSessionId;
    this.relay = relay;
    this.task = task;
    this.isInbound = !task;
    this.broadcast = opts?.broadcast;
    this.assistantId = opts?.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID;
    this.trustContext = opts?.trustContext ?? null;

    // Resolve the conversation ID from the call session
    const session = getCallSession(callSessionId);
    this.conversationId = session?.conversationId ?? callSessionId;

    this.startDurationTimer();
    this.resetSilenceTimer();
    registerCallController(callSessionId, this);
  }

  /**
   * Returns the current controller state.
   */
  getState(): ControllerState {
    return this.state;
  }

  /**
   * Returns the question ID of the currently pending guardian consultation,
   * or null if no consultation is active. Used by answerCall to match
   * incoming answers to the correct consultation record.
   */
  getPendingConsultationQuestionId(): string | null {
    return this.pendingGuardianInput?.questionId ?? null;
  }

  /**
   * Update guardian trust context for subsequent LLM turns.
   */
  setTrustContext(ctx: TrustContext | null): void {
    this.trustContext = ctx;
  }

  /**
   * Mark the next caller utterance as an opening acknowledgment so it
   * receives the [CALL_OPENING_ACK] marker. Used after deterministic
   * transitions (e.g. post-approval handoff) to ensure the next LLM
   * turn continues naturally without reintroduction.
   *
   * Also resets the silence timer so the "Are you still there?" nudge
   * fires at the correct interval after the deterministic handoff copy.
   */
  markNextCallerTurnAsOpeningAck(): void {
    this.awaitingOpeningAck = true;
    this.lastSentWasOpener = false;
    this.resetSilenceTimer();
  }

  /**
   * Kick off the first outbound call utterance from the assistant.
   */
  async startInitialGreeting(): Promise<void> {
    if (this.initialGreetingStarted) return;
    if (this.state !== "idle") return;

    this.initialGreetingStarted = true;
    this.resetSilenceTimer();
    this.lastSentWasOpener = true;
    await this.runTurn(CALL_OPENING_MARKER);
  }

  /**
   * Handle a final caller utterance from the ConversationRelay.
   * Caller utterances always trigger normal turns, even when a guardian
   * consultation is pending — the consultation is tracked separately.
   */
  async handleCallerUtterance(
    transcript: string,
    speaker?: PromptSpeakerContext,
  ): Promise<void> {
    const interruptedInFlight =
      this.state === "processing" || this.state === "speaking";
    // If we're already processing or speaking, abort the in-flight generation
    if (interruptedInFlight) {
      this.abortCurrentTurn();
      this.llmRunVersion++; // Invalidate stale turn before awaiting teardown
    }

    // Always await any lingering turn promise, even if handleInterrupt() already ran
    if (this.currentTurnPromise) {
      const teardownPromise = this.currentTurnPromise;
      this.currentTurnPromise = null;
      await Promise.race([
        teardownPromise.catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    }

    this.state = "processing";
    this.resetSilenceTimer();
    const callerContent = this.formatCallerUtterance(transcript, speaker);
    const shouldMarkOpeningAck = this.awaitingOpeningAck;
    if (shouldMarkOpeningAck) {
      this.awaitingOpeningAck = false;
    }
    const callerTurnContent = shouldMarkOpeningAck
      ? callerContent.length > 0
        ? `${CALL_OPENING_ACK_MARKER}\n${callerContent}`
        : CALL_OPENING_ACK_MARKER
      : callerContent;

    this.lastSentWasOpener = false;
    await this.runTurn(callerTurnContent);
  }

  /**
   * Called when the guardian (via chat UI or channel) answers a pending
   * consultation question. Acceptance is gated on having an active
   * pending consultation record, not on controller turn state — so
   * answers can arrive while the controller is idle, processing, or
   * speaking.
   */
  async handleUserAnswer(answerText: string): Promise<boolean> {
    if (!this.pendingGuardianInput) {
      log.warn(
        { callSessionId: this.callSessionId, state: this.state },
        "handleUserAnswer called but no pending consultation exists",
      );
      return false;
    }

    // Clear the consultation timeout and record
    clearTimeout(this.pendingGuardianInput.timer);
    this.pendingGuardianInput = null;

    updateCallSession(this.callSessionId, { status: "in_progress" });

    // Inject the answer as a queued instruction so it merges into the
    // next turn naturally, respecting role-alternation. If the controller
    // is idle the instruction flush will fire a turn immediately.
    this.pendingInstructions.push(`[USER_ANSWERED: ${answerText}]`);

    // If the controller is idle, flush instructions immediately to
    // deliver the answer. If processing/speaking, the answer will be
    // delivered when the current turn completes via flushPendingInstructions.
    if (this.state === "idle") {
      this.flushPendingInstructions();
    }

    return true;
  }

  /**
   * Inject a user instruction into the controller's conversation.
   * The instruction is formatted as a dedicated marker that the system prompt
   * tells the model to treat as high-priority steering input.
   *
   * When the LLM is actively processing or speaking, the instruction is
   * queued and spliced into the conversation at the correct chronological
   * position once the current turn completes.
   */
  async handleUserInstruction(instructionText: string): Promise<void> {
    recordCallEvent(this.callSessionId, "user_instruction_relayed", {
      instruction: instructionText,
    });

    // Queue the instruction when it cannot be safely appended right now
    if (this.state === "processing" || this.state === "speaking") {
      this.pendingInstructions.push(`[USER_INSTRUCTION: ${instructionText}]`);
      return;
    }

    // Reset the silence timer so the instruction-triggered LLM turn
    // doesn't race with a stale silence timeout.
    this.resetSilenceTimer();

    await this.runTurn(`[USER_INSTRUCTION: ${instructionText}]`);
  }

  /**
   * Handle caller interrupting the assistant's speech.
   */
  handleInterrupt(): void {
    const wasSpeaking = this.state === "speaking";
    this.abortCurrentTurn();
    this.llmRunVersion++;
    // Explicitly terminate the in-progress TTS turn so the relay can
    // immediately hand control back to the caller after barge-in.
    if (wasSpeaking) {
      this.relay.sendTextToken("", true);
    }
    this.state = "idle";
    // Restart silence detection so a barge-in that never yields a
    // follow-up utterance doesn't leave the call without a watchdog.
    this.resetSilenceTimer();
  }

  /**
   * Tear down all timers and abort any in-flight work.
   */
  destroy(): void {
    this.destroyed = true;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.durationTimer) clearTimeout(this.durationTimer);
    if (this.durationWarningTimer) clearTimeout(this.durationWarningTimer);
    if (this.pendingGuardianInput) {
      clearTimeout(this.pendingGuardianInput.timer);
      this.pendingGuardianInput = null;
    }
    if (this.durationEndTimer) {
      clearTimeout(this.durationEndTimer);
      this.durationEndTimer = null;
    }
    this.pendingInstructions = [];
    this.llmRunVersion++;
    this.abortCurrentTurn();
    this.currentTurnPromise = null;
    unregisterCallController(this.callSessionId);

    // Revoke any scoped approval grants bound to this call session.
    // Revoke by both callSessionId and conversationId because the
    // guardian-approval-interception minting path sets callSessionId: null
    // but always sets conversationId.
    try {
      let revoked = revokeScopedApprovalGrantsForContext({
        callSessionId: this.callSessionId,
      });
      revoked += revokeScopedApprovalGrantsForContext({
        conversationId: this.conversationId,
      });
      if (revoked > 0) {
        log.info(
          {
            callSessionId: this.callSessionId,
            conversationId: this.conversationId,
            revokedCount: revoked,
          },
          "Revoked scoped grants on call end",
        );
      }
    } catch (err) {
      log.warn(
        { err, callSessionId: this.callSessionId },
        "Failed to revoke scoped grants on call end",
      );
    }

    log.info({ callSessionId: this.callSessionId }, "CallController destroyed");
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Abort the current in-flight turn using the VoiceTurnHandle if available,
   * plus the local AbortController for signal propagation.
   */
  private abortCurrentTurn(): void {
    if (this.currentTurnHandle) {
      this.currentTurnHandle.abort();
      this.currentTurnHandle = null;
    }
    this.abortController.abort();
    this.abortController = new AbortController();
  }

  private formatCallerUtterance(
    transcript: string,
    speaker?: PromptSpeakerContext,
  ): string {
    if (!speaker) return transcript;
    const safeId = speaker.speakerId.replaceAll('"', "'");
    const safeLabel = speaker.speakerLabel.replaceAll('"', "'");
    const confidencePart =
      speaker.speakerConfidence != null
        ? ` confidence="${speaker.speakerConfidence.toFixed(2)}"`
        : "";
    return `[SPEAKER id="${safeId}" label="${safeLabel}" source="${speaker.source}"${confidencePart}] ${transcript}`;
  }

  /**
   * Execute a single voice turn through the session pipeline and stream
   * the response back through the relay.
   */
  private runTurn(content: string): Promise<void> {
    const promise = this.runTurnInner(content);
    this.currentTurnPromise = promise;
    return promise;
  }

  private async runTurnInner(content: string): Promise<void> {
    if (this.destroyed) return;
    const runVersion = ++this.llmRunVersion;
    const runSignal = this.abortController.signal;

    // Clear silence timer while actively processing. The caller said
    // something (or a turn was triggered), so silence detection should
    // pause until we finish responding and return to idle.
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }

    try {
      this.state = "speaking";

      const fullResponseText = await this.streamTtsTokens(
        content,
        runVersion,
        runSignal,
      );
      if (!this.isCurrentRun(runVersion)) return;

      this.handleTurnCompletion(fullResponseText);
    } catch (err: unknown) {
      this.currentTurnHandle = null;
      // Aborted requests are expected (interruptions, rapid utterances)
      if (this.isExpectedAbortError(err) || runSignal.aborted) {
        log.debug(
          {
            callSessionId: this.callSessionId,
            errName: err instanceof Error ? err.name : typeof err,
            stale: !this.isCurrentRun(runVersion),
          },
          "Voice turn aborted",
        );
        if (this.isCurrentRun(runVersion)) {
          this.state = "idle";
          this.resetSilenceTimer();
        }
        return;
      }
      if (!this.isCurrentRun(runVersion)) {
        log.debug(
          {
            callSessionId: this.callSessionId,
            errName: err instanceof Error ? err.name : typeof err,
          },
          "Ignoring stale voice turn error from superseded turn",
        );
        return;
      }
      log.error({ err, callSessionId: this.callSessionId }, "Voice turn error");
      this.relay.sendTextToken(
        "I'm sorry, I encountered a technical issue. Could you repeat that?",
        true,
      );
      this.state = "idle";
      this.resetSilenceTimer();
      this.flushPendingInstructions();
    }
  }

  /**
   * Stream TTS tokens from the session pipeline, buffering to strip
   * control markers before they reach the relay. Returns the full
   * accumulated response text for post-turn marker detection.
   */
  private async streamTtsTokens(
    content: string,
    runVersion: number,
    runSignal: AbortSignal,
  ): Promise<string> {
    // Buffer incoming tokens so we can strip control markers ([ASK_GUARDIAN:...], [END_CALL])
    // before they reach TTS. We hold text whenever an unmatched '[' appears, since it
    // could be the start of a control marker.
    let ttsBuffer = "";
    let fullResponseText = "";

    const flushSafeText = (): void => {
      if (!this.isCurrentRun(runVersion)) return;
      if (ttsBuffer.length === 0) return;
      const bracketIdx = ttsBuffer.indexOf("[");
      if (bracketIdx === -1) {
        // No bracket at all — safe to flush everything
        this.relay.sendTextToken(ttsBuffer, false);
        ttsBuffer = "";
      } else {
        // Flush everything before the bracket
        if (bracketIdx > 0) {
          this.relay.sendTextToken(ttsBuffer.slice(0, bracketIdx), false);
          ttsBuffer = ttsBuffer.slice(bracketIdx);
        }

        // Only hold the buffer if the bracket text could be the start of a
        // known control marker. Otherwise flush immediately so ordinary
        // bracketed text (e.g. "[A]", "[note]") doesn't stall TTS.
        const afterBracket = ttsBuffer;
        const couldBeControl = couldBeControlMarker(afterBracket);

        if (!couldBeControl) {
          // Not a control marker prefix — flush up to the next '[' (if any)
          const nextBracket = ttsBuffer.indexOf("[", 1);
          if (nextBracket === -1) {
            this.relay.sendTextToken(ttsBuffer, false);
            ttsBuffer = "";
          } else {
            this.relay.sendTextToken(ttsBuffer.slice(0, nextBracket), false);
            ttsBuffer = ttsBuffer.slice(nextBracket);
          }
        }
        // Otherwise hold it — might be a control marker still being streamed
      }
    };

    // Use a promise to track completion of the voice turn
    const turnComplete = new Promise<void>((resolve, reject) => {
      const onTextDelta = (text: string): void => {
        if (!this.isCurrentRun(runVersion)) return;
        fullResponseText += text;
        ttsBuffer += text;
        ttsBuffer = stripInternalSpeechMarkers(ttsBuffer);
        flushSafeText();
      };

      const onComplete = (): void => {
        resolve();
      };

      const onError = (message: string): void => {
        reject(new Error(message));
      };

      // Start the voice turn through the session bridge
      startVoiceTurn({
        conversationId: this.conversationId,
        callSessionId: this.callSessionId,
        content,
        assistantId: this.assistantId,
        trustContext: this.trustContext ?? undefined,
        isInbound: this.isInbound,
        task: this.task,
        onTextDelta,
        onComplete,
        onError,
        signal: runSignal,
      })
        .then((handle) => {
          if (this.isCurrentRun(runVersion)) {
            this.currentTurnHandle = handle;
          } else {
            // Turn was superseded before handle arrived; abort immediately
            handle.abort();
          }
        })
        .catch((err) => {
          reject(err);
        });

      // Defensive: if the turn is aborted (e.g. barge-in) and the event
      // sink callbacks are never invoked, resolve the promise so it
      // doesn't hang forever.
      runSignal.addEventListener(
        "abort",
        () => {
          resolve();
        },
        { once: true },
      );
    });

    // Eagerly mark the rejection as handled so runtimes (e.g. bun) don't
    // flag it as an unhandled rejection when onError fires synchronously
    // inside the Promise constructor before this await adds its handler.
    // The await below still re-throws, caught by the outer try-catch.
    turnComplete.catch(() => {});
    await turnComplete;
    if (!this.isCurrentRun(runVersion)) return fullResponseText;

    // Final sweep: strip any remaining control markers from the buffer
    ttsBuffer = stripInternalSpeechMarkers(ttsBuffer);
    if (ttsBuffer.length > 0) {
      this.relay.sendTextToken(ttsBuffer, false);
    }

    // Signal end of this turn's speech
    this.relay.sendTextToken("", true);

    // Mark the greeting's first response as awaiting ack
    if (this.lastSentWasOpener && fullResponseText.length > 0) {
      this.awaitingOpeningAck = true;
      this.lastSentWasOpener = false;
    }

    return fullResponseText;
  }

  /**
   * Handle post-turn marker detection and dispatch: guardian consultation
   * (ASK_GUARDIAN_APPROVAL / ASK_GUARDIAN), call finalization (END_CALL),
   * and normal idle transition.
   */
  private handleTurnCompletion(fullResponseText: string): void {
    const responseText = fullResponseText;

    // Record the assistant response event
    recordCallEvent(this.callSessionId, "assistant_spoke", {
      text: responseText,
    });
    const spokenText = stripInternalSpeechMarkers(responseText).trim();
    if (spokenText.length > 0) {
      const session = getCallSession(this.callSessionId);
      if (session) {
        fireCallTranscriptNotifier(
          session.conversationId,
          this.callSessionId,
          "assistant",
          spokenText,
        );
      }
    }

    // Check for structured tool-approval ASK_GUARDIAN_APPROVAL first,
    // then informational ASK_GUARDIAN. Uses brace-balanced extraction so
    // `}]` inside JSON string values does not truncate the payload or
    // leak partial JSON into TTS output.
    const approvalMatch = extractBalancedJson(responseText);
    let toolApprovalMeta: {
      question: string;
      toolName: string;
      inputDigest: string;
    } | null = null;
    if (approvalMatch) {
      try {
        const parsed = JSON.parse(approvalMatch.json) as {
          question?: string;
          toolName?: string;
          input?: Record<string, unknown>;
        };
        if (parsed.question && parsed.toolName && parsed.input) {
          const digest = computeToolApprovalDigest(
            parsed.toolName,
            parsed.input,
          );
          toolApprovalMeta = {
            question: parsed.question,
            toolName: parsed.toolName,
            inputDigest: digest,
          };
        }
      } catch {
        log.warn(
          { callSessionId: this.callSessionId },
          "Failed to parse ASK_GUARDIAN_APPROVAL JSON payload",
        );
      }
    }

    const askMatch = toolApprovalMeta
      ? null // structured approval takes precedence
      : responseText.match(ASK_GUARDIAN_CAPTURE_REGEX);

    const questionText =
      toolApprovalMeta?.question ?? (askMatch ? askMatch[1] : null);

    if (questionText) {
      if (this.isCallerGuardian()) {
        // Caller IS the guardian — don't dispatch cross-channel.
        // Queue an instruction so the next turn asks them directly.
        log.info(
          { callSessionId: this.callSessionId },
          "Caller is guardian — skipping ASK_GUARDIAN dispatch, asking directly",
        );
        this.pendingInstructions.push(
          `You just tried to use [ASK_GUARDIAN] but the person on the phone IS your guardian. Ask them directly: "${questionText}"`,
        );
        // Fall through to normal turn completion (idle + flushPendingInstructions)
      } else if (this.guardianUnavailableForCall) {
        // Guardian already timed out earlier in this call — skip the full
        // consultation wait and immediately tell the model to proceed
        // without guardian input.
        log.info(
          { callSessionId: this.callSessionId },
          "Guardian unavailable for call — skipping ASK_GUARDIAN wait",
        );
        recordCallEvent(this.callSessionId, "guardian_unavailable_skipped", {
          question: questionText,
        });
        this.pendingInstructions.push(
          `[GUARDIAN_UNAVAILABLE] You tried to consult your guardian again, but they were already unreachable earlier in this call. ` +
            `Do NOT use [ASK_GUARDIAN] again. Instead, let the caller know you cannot reach the guardian right now, ` +
            `and continue the conversation by asking if there is anything else you can help with or if they would like a callback. ` +
            `The unanswered question was: "${questionText}"`,
        );
        // Fall through to normal turn completion (idle + flushPendingInstructions)
      } else if (
        this.pendingInstructions.some((instr) =>
          instr.startsWith("[USER_ANSWERED:"),
        )
      ) {
        // A guardian answer arrived mid-turn and is queued in
        // pendingInstructions but hasn't been flushed yet. The in-flight
        // LLM response was generated without knowledge of this answer, so
        // creating a new consultation now would supersede the old one and
        // desynchronize the flow. Skip this consultation — the answer will
        // be flushed on the next turn, and if the model still needs to
        // consult a guardian, it will emit another ASK_GUARDIAN then.
        log.info(
          { callSessionId: this.callSessionId },
          "Deferring ASK_GUARDIAN — queued USER_ANSWERED pending",
        );
        recordCallEvent(this.callSessionId, "guardian_consult_deferred", {
          question: questionText,
        });
        // Fall through to normal turn completion (idle + flushPendingInstructions)
      } else {
        // Determine the effective tool metadata for this ask. If the new
        // ask has structured tool metadata, use it; otherwise inherit from
        // the prior pending consultation (preserves tool scope on re-asks).
        const effectiveToolMeta = toolApprovalMeta
          ? {
              toolName: toolApprovalMeta.toolName,
              inputDigest: toolApprovalMeta.inputDigest,
            }
          : (this.pendingGuardianInput?.toolApprovalMeta ?? null);

        // Coalesce repeated identical asks: if a consultation is already
        // pending for the same tool/action (or same informational question),
        // avoid churning requests and just keep the existing one.
        if (this.pendingGuardianInput) {
          const isSameToolAction =
            effectiveToolMeta && this.pendingGuardianInput.toolApprovalMeta
              ? effectiveToolMeta.toolName ===
                  this.pendingGuardianInput.toolApprovalMeta.toolName &&
                effectiveToolMeta.inputDigest ===
                  this.pendingGuardianInput.toolApprovalMeta.inputDigest
              : !effectiveToolMeta &&
                !this.pendingGuardianInput.toolApprovalMeta;

          if (isSameToolAction) {
            // Same tool/action — coalesce. Keep the existing consultation
            // alive and skip creating a new request.
            log.info(
              {
                callSessionId: this.callSessionId,
                questionId: this.pendingGuardianInput.questionId,
              },
              "Coalescing repeated ASK_GUARDIAN — same tool/action already pending",
            );
            recordCallEvent(this.callSessionId, "guardian_consult_coalesced", {
              question: questionText,
            });
            // Fall through to normal turn completion (idle + flushPendingInstructions)
          } else {
            // Materially different intent — supersede the old consultation.
            clearTimeout(this.pendingGuardianInput.timer);

            // Expire the previous consultation's storage records so stale
            // guardian answers cannot match the old request.
            expirePendingQuestions(this.callSessionId);
            const previousRequest = getPendingCanonicalRequestByCallSessionId(
              this.callSessionId,
            );
            if (previousRequest) {
              // Immediately expire with 'superseded' reason to prevent
              // stale answers from resolving the old request.
              expireCanonicalGuardianRequest(previousRequest.id);
              log.info(
                {
                  callSessionId: this.callSessionId,
                  requestId: previousRequest.id,
                },
                "Superseded guardian action request (materially different intent)",
              );
            }

            this.pendingGuardianInput = null;

            // Dispatch the new consultation with effective tool metadata.
            // The previous request ID is passed through so the dispatch
            // can backfill supersession chain metadata (superseded_by_request_id)
            // once the new request has been created.
            this.dispatchNewConsultation(
              questionText,
              effectiveToolMeta,
              previousRequest?.id ?? null,
            );
          }
        } else {
          // No prior consultation — dispatch fresh
          this.dispatchNewConsultation(questionText, effectiveToolMeta, null);
        }
      }
    }

    // Check for END_CALL marker
    if (responseText.includes(END_CALL_MARKER)) {
      // Clear any pending consultation before completing the call.
      // Without this, the consultation timeout can fire on an already-ended
      // call, overwriting 'completed' status back to 'in_progress' and
      // starting a new LLM turn on a dead session. Similarly, a late
      // handleUserAnswer could be accepted since pendingGuardianInput is
      // still non-null.
      if (this.pendingGuardianInput) {
        clearTimeout(this.pendingGuardianInput.timer);

        // Expire store-side consultation records so clients don't observe
        // a completed call with a dangling pendingQuestion, and guardian
        // replies are cleanly rejected instead of hitting answerCall failures.
        expirePendingQuestions(this.callSessionId);
        const previousRequest = getPendingCanonicalRequestByCallSessionId(
          this.callSessionId,
        );
        if (previousRequest) {
          expireCanonicalGuardianRequest(previousRequest.id);
        }

        this.pendingGuardianInput = null;
      }

      const currentSession = getCallSession(this.callSessionId);
      const shouldNotifyCompletion = currentSession
        ? currentSession.status !== "completed" &&
          currentSession.status !== "failed" &&
          currentSession.status !== "cancelled"
        : false;

      this.relay.endSession("Call completed");
      updateCallSession(this.callSessionId, {
        status: "completed",
        endedAt: Date.now(),
      });
      recordCallEvent(this.callSessionId, "call_ended", {
        reason: "completed",
      });

      // Notify the voice conversation
      if (shouldNotifyCompletion && currentSession) {
        finalizeCall(this.callSessionId, currentSession.conversationId);
      }

      // Post a pointer message in the initiating conversation
      if (currentSession?.initiatedFromConversationId) {
        const durationMs = currentSession.startedAt
          ? Date.now() - currentSession.startedAt
          : 0;
        addPointerMessage(
          currentSession.initiatedFromConversationId,
          "completed",
          currentSession.toNumber,
          {
            duration: durationMs > 0 ? formatDuration(durationMs) : undefined,
          },
        ).catch((err) => {
          log.warn(
            {
              conversationId: currentSession.initiatedFromConversationId,
              err,
            },
            "Skipping pointer write — origin conversation may no longer exist",
          );
        });
      }
      this.state = "idle";
      return;
    }

    // Normal turn complete — restart silence detection and flush any
    // instructions that arrived while the LLM was active.
    this.state = "idle";
    this.currentTurnHandle = null;
    this.resetSilenceTimer();
    this.flushPendingInstructions();
  }

  private isExpectedAbortError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return err.name === "AbortError" || err.name === "APIUserAbortError";
  }

  private isCurrentRun(runVersion: number): boolean {
    return runVersion === this.llmRunVersion;
  }

  private isCallerGuardian(): boolean {
    return this.trustContext?.trustClass === "guardian";
  }

  /**
   * Create a new consultation: persist a pending question, dispatch
   * guardian action request to channels, and start the consultation timer.
   *
   * If `supersededRequestId` is provided, backfills the supersession
   * chain after the new request is created.
   */
  private dispatchNewConsultation(
    questionText: string,
    effectiveToolMeta: { toolName: string; inputDigest: string } | null,
    supersededRequestId: string | null,
  ): void {
    const pendingQuestion = createPendingQuestion(
      this.callSessionId,
      questionText,
    );
    updateCallSession(this.callSessionId, { status: "waiting_on_user" });
    recordCallEvent(this.callSessionId, "user_question_asked", {
      question: questionText,
    });

    // Notify the conversation that a question was asked
    const session = getCallSession(this.callSessionId);
    if (session) {
      fireCallQuestionNotifier(
        session.conversationId,
        this.callSessionId,
        questionText,
      );

      // Dispatch guardian action request to all configured channels
      // Capture the pending question ID in a closure for stable lookup
      // after the async dispatch completes — avoids a racy
      // getPendingRequestByCallSessionId lookup that could return a
      // different request if another supersession occurs during the gap.
      const stablePendingQuestionId = pendingQuestion.id;
      void dispatchGuardianQuestion({
        callSessionId: this.callSessionId,
        conversationId: session.conversationId,
        assistantId: this.assistantId,
        pendingQuestion,
        toolName: effectiveToolMeta?.toolName,
        inputDigest: effectiveToolMeta?.inputDigest,
      }).then(() => {
        // Backfill supersession chain: now that the new request exists in
        // the store, link the old request to the new one.
        if (supersededRequestId) {
          const newRequest = getCanonicalRequestByPendingQuestionId(
            stablePendingQuestionId,
          );
          if (newRequest) {
            // Canonical store does not track supersession metadata;
            // the old request was already expired above.
            log.info(
              {
                callSessionId: this.callSessionId,
                oldRequestId: supersededRequestId,
                newRequestId: newRequest.id,
              },
              "Supersession chain: new canonical request created",
            );
          }
        }
      });
    }

    // Set a consultation timeout tied to this specific consultation
    // record, not the global controller state.
    const consultationTimer = setTimeout(() => {
      // Only fire if this consultation is still the active one
      if (
        !this.pendingGuardianInput ||
        this.pendingGuardianInput.questionId !== pendingQuestion.id
      )
        return;

      log.info(
        { callSessionId: this.callSessionId },
        "Guardian consultation timed out",
      );

      // Mark the linked guardian action request as timed out and
      // send expiry notices to guardian destinations. Deliveries
      // must be captured before markTimedOutWithReason changes
      // their status.
      const pendingActionRequest = getPendingCanonicalRequestByCallSessionId(
        this.callSessionId,
      );
      if (pendingActionRequest) {
        const canonicalDeliveries = listCanonicalGuardianDeliveries(
          pendingActionRequest.id,
        );
        // Expire the canonical request and its deliveries
        expireCanonicalGuardianRequest(pendingActionRequest.id);
        log.info(
          {
            callSessionId: this.callSessionId,
            requestId: pendingActionRequest.id,
          },
          "Marked canonical guardian request as timed out",
        );
        void sendGuardianExpiryNotices(
          canonicalDeliveries,
          this.assistantId,
          getGatewayInternalBaseUrl(),
          () => mintDaemonDeliveryToken(),
        ).catch((err) => {
          log.error(
            {
              err,
              callSessionId: this.callSessionId,
              requestId: pendingActionRequest.id,
            },
            "Failed to send guardian action expiry notices after call timeout",
          );
        });
      }

      // Expire pending questions and update call state
      expirePendingQuestions(this.callSessionId);
      this.pendingGuardianInput = null;
      updateCallSession(this.callSessionId, { status: "in_progress" });
      this.guardianUnavailableForCall = true;
      recordCallEvent(this.callSessionId, "guardian_consultation_timed_out", {
        question: questionText,
      });

      // Inject timeout instruction so the model addresses it on the
      // next turn. If idle, flush immediately; otherwise it merges
      // into the next turn completion.
      const timeoutInstruction =
        `[GUARDIAN_TIMEOUT] Your guardian did not respond in time to your question: "${questionText}". ` +
        `Apologize to the caller for the delay, let them know you were unable to reach your guardian, ` +
        `ask if they would like to leave a message or receive a callback, ` +
        `and ask if there are any other questions you can help with right now.`;

      this.pendingInstructions.push(timeoutInstruction);

      if (this.state === "idle") {
        this.resetSilenceTimer();
        this.flushPendingInstructions();
      }
    }, getUserConsultationTimeoutMs());

    this.pendingGuardianInput = {
      questionText,
      questionId: pendingQuestion.id,
      toolApprovalMeta: effectiveToolMeta,
      timer: consultationTimer,
    };
  }

  /**
   * Drain any instructions that were queued while the LLM was active.
   */
  private flushPendingInstructions(): void {
    if (this.destroyed) return;
    if (this.pendingInstructions.length === 0) return;

    const parts = this.pendingInstructions.map((instr) =>
      instr.startsWith("[") ? instr : `[USER_INSTRUCTION: ${instr}]`,
    );
    this.pendingInstructions = [];

    const content = parts.join("\n");

    this.resetSilenceTimer();

    // Fire-and-forget so we don't block the current turn's cleanup.
    this.runTurn(content).catch((err) =>
      log.error(
        { err, callSessionId: this.callSessionId },
        "runTurn failed after flushing queued instructions",
      ),
    );
  }

  private startDurationTimer(): void {
    const maxDurationMs = getMaxCallDurationMs();
    const warningMs = maxDurationMs - 2 * 60 * 1000; // 2 minutes before max

    if (warningMs > 0) {
      this.durationWarningTimer = setTimeout(() => {
        log.info(
          { callSessionId: this.callSessionId },
          "Call duration warning",
        );
        this.relay.sendTextToken(
          "Just to let you know, we're running low on time for this call.",
          true,
        );
      }, warningMs);
    }

    this.durationTimer = setTimeout(() => {
      log.info(
        { callSessionId: this.callSessionId },
        "Call duration limit reached",
      );
      this.relay.sendTextToken(
        "I'm sorry, but we've reached the maximum time for this call. Thank you for your time. Goodbye!",
        true,
      );
      // Give TTS a moment to play, then end
      this.durationEndTimer = setTimeout(() => {
        const currentSession = getCallSession(this.callSessionId);
        const shouldNotifyCompletion = currentSession
          ? currentSession.status !== "completed" &&
            currentSession.status !== "failed" &&
            currentSession.status !== "cancelled"
          : false;

        this.relay.endSession("Maximum call duration reached");
        updateCallSession(this.callSessionId, {
          status: "completed",
          endedAt: Date.now(),
        });
        recordCallEvent(this.callSessionId, "call_ended", {
          reason: "max_duration",
        });
        if (shouldNotifyCompletion && currentSession) {
          finalizeCall(this.callSessionId, currentSession.conversationId);
        }

        // Post a pointer message in the initiating conversation
        if (currentSession?.initiatedFromConversationId) {
          const durationMs = currentSession.startedAt
            ? Date.now() - currentSession.startedAt
            : 0;
          addPointerMessage(
            currentSession.initiatedFromConversationId,
            "completed",
            currentSession.toNumber,
            {
              duration: durationMs > 0 ? formatDuration(durationMs) : undefined,
            },
          ).catch((err) => {
            log.warn(
              {
                conversationId: currentSession.initiatedFromConversationId,
                err,
              },
              "Skipping pointer write — origin conversation may no longer exist",
            );
          });
        }
      }, 3000);
    }, maxDurationMs);
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.destroyed) return;
    this.silenceTimer = setTimeout(() => {
      // During guardian wait states, the relay heartbeat timer handles
      // periodic updates — suppress the generic "Are you still there?"
      // which is confusing when the caller is waiting on a decision.
      // Two paths: in-call consultation (pendingGuardianInput) and
      // inbound access-request wait (relay state).
      if (
        this.pendingGuardianInput ||
        this.relay.getConnectionState() === "awaiting_guardian_decision"
      ) {
        log.debug(
          { callSessionId: this.callSessionId },
          "Silence timeout suppressed during guardian wait",
        );
        return;
      }
      log.info(
        { callSessionId: this.callSessionId },
        "Silence timeout triggered",
      );
      this.relay.sendTextToken("Are you still there?", true);
    }, getSilenceTimeoutMs());
  }
}

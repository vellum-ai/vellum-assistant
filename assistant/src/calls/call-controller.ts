/**
 * Session-backed voice call controller.
 *
 * Routes voice turns through the daemon session pipeline via
 * voice-session-bridge instead of calling provider.sendMessage() directly.
 * This gives voice calls access to tools, memory, skills, and runtime
 * injections while preserving all existing call UX behavior (control markers,
 * barge-in, state machine, guardian verification).
 */

import { getLogger } from '../util/logger.js';
import {
  getCallSession,
  updateCallSession,
  recordCallEvent,
  createPendingQuestion,
  expirePendingQuestions,
} from './call-store.js';
import { getMaxCallDurationMs, getUserConsultationTimeoutMs, SILENCE_TIMEOUT_MS } from './call-constants.js';
import type { RelayConnection } from './relay-server.js';
import { registerCallController, unregisterCallController, fireCallQuestionNotifier, fireCallCompletionNotifier, fireCallTranscriptNotifier } from './call-state.js';
import type { PromptSpeakerContext } from './speaker-identification.js';
import { addPointerMessage, formatDuration } from './call-pointer-messages.js';
import { persistCallCompletionMessage } from './call-conversation-messages.js';
import { dispatchGuardianQuestion } from './guardian-dispatch.js';
import type { ServerMessage } from '../daemon/ipc-contract.js';
import type { GuardianRuntimeContext } from '../daemon/session-runtime-assembly.js';
import { startVoiceTurn, type VoiceTurnHandle } from './voice-session-bridge.js';

const log = getLogger('call-controller');

type ControllerState = 'idle' | 'processing' | 'waiting_on_user' | 'speaking';

const ASK_GUARDIAN_CAPTURE_REGEX = /\[ASK_GUARDIAN:\s*(.+?)\]/;
const ASK_GUARDIAN_MARKER_REGEX = /\[ASK_GUARDIAN:\s*.+?\]/g;
const USER_ANSWERED_MARKER_REGEX = /\[USER_ANSWERED:\s*.+?\]/g;
const USER_INSTRUCTION_MARKER_REGEX = /\[USER_INSTRUCTION:\s*.+?\]/g;
const CALL_OPENING_MARKER_REGEX = /\[CALL_OPENING\]/g;
const CALL_OPENING_ACK_MARKER_REGEX = /\[CALL_OPENING_ACK\]/g;
const END_CALL_MARKER_REGEX = /\[END_CALL\]/g;
const CALL_OPENING_MARKER = '[CALL_OPENING]';
const CALL_OPENING_ACK_MARKER = '[CALL_OPENING_ACK]';
const END_CALL_MARKER = '[END_CALL]';

function stripInternalSpeechMarkers(text: string): string {
  return text
    .replace(ASK_GUARDIAN_MARKER_REGEX, '')
    .replace(USER_ANSWERED_MARKER_REGEX, '')
    .replace(USER_INSTRUCTION_MARKER_REGEX, '')
    .replace(CALL_OPENING_MARKER_REGEX, '')
    .replace(CALL_OPENING_ACK_MARKER_REGEX, '')
    .replace(END_CALL_MARKER_REGEX, '');
}

export class CallController {
  private callSessionId: string;
  private relay: RelayConnection;
  private state: ControllerState = 'idle';
  private abortController: AbortController = new AbortController();
  private currentTurnHandle: VoiceTurnHandle | null = null;
  private currentTurnPromise: Promise<void> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private durationWarningTimer: ReturnType<typeof setTimeout> | null = null;
  private consultationTimer: ReturnType<typeof setTimeout> | null = null;
  private durationEndTimer: ReturnType<typeof setTimeout> | null = null;
  private task: string | null;
  /** True when the call session was created via the inbound path (no outbound task). */
  private isInbound: boolean;
  /** Instructions queued while an LLM turn is in-flight or during waiting_on_user */
  private pendingInstructions: string[] = [];
  /** Caller utterances queued while waiting_on_user to prevent re-entrant turns */
  private pendingCallerUtterances: Array<{transcript: string, speaker?: PromptSpeakerContext}> = [];
  /** Ensures the call opener is triggered at most once per call. */
  private initialGreetingStarted = false;
  /** Marks that the next caller turn should be treated as an opening acknowledgment. */
  private awaitingOpeningAck = false;
  /** Monotonic run id used to suppress stale turn side effects after interruption. */
  private llmRunVersion = 0;
  /** Optional broadcast function for emitting IPC events to connected clients. */
  private broadcast?: (msg: ServerMessage) => void;
  /** Assistant identity for scoping guardian bindings. */
  private assistantId: string;
  /** Guardian trust context for the current caller, when available. */
  private guardianContext: GuardianRuntimeContext | null;
  /** Conversation ID for the voice session. */
  private conversationId: string;
  /**
   * Track whether the last message sent to the session was a user message
   * whose assistant response has not yet been received. This is used to
   * prevent sending consecutive user messages that would violate role
   * alternation in the underlying session pipeline.
   */
  private lastSentWasOpener = false;

  constructor(
    callSessionId: string,
    relay: RelayConnection,
    task: string | null,
    opts?: {
      broadcast?: (msg: ServerMessage) => void;
      assistantId?: string;
      guardianContext?: GuardianRuntimeContext;
    },
  ) {
    this.callSessionId = callSessionId;
    this.relay = relay;
    this.task = task;
    this.isInbound = !task;
    this.broadcast = opts?.broadcast;
    this.assistantId = opts?.assistantId ?? 'self';
    this.guardianContext = opts?.guardianContext ?? null;

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
   * Update guardian trust context for subsequent LLM turns.
   */
  setGuardianContext(ctx: GuardianRuntimeContext | null): void {
    this.guardianContext = ctx;
  }

  /**
   * Kick off the first outbound call utterance from the assistant.
   */
  async startInitialGreeting(): Promise<void> {
    if (this.initialGreetingStarted) return;
    if (this.state !== 'idle') return;

    this.initialGreetingStarted = true;
    this.resetSilenceTimer();
    this.lastSentWasOpener = true;
    await this.runTurn(CALL_OPENING_MARKER);
  }

  /**
   * Handle a final caller utterance from the ConversationRelay.
   */
  async handleCallerUtterance(transcript: string, speaker?: PromptSpeakerContext): Promise<void> {
    // Do not start a new turn while waiting for guardian input — queue
    // the utterance so it can be processed after the answer arrives.
    if (this.state === 'waiting_on_user') {
      log.warn(
        { callSessionId: this.callSessionId },
        'Caller utterance received while waiting_on_user — queued for after answer.',
      );
      this.pendingCallerUtterances.push({ transcript, speaker });
      return;
    }

    const interruptedInFlight = this.state === 'processing' || this.state === 'speaking';
    // If we're already processing or speaking, abort the in-flight generation
    if (interruptedInFlight) {
      this.abortCurrentTurn();
      this.llmRunVersion++;  // Invalidate stale turn before awaiting teardown
    }

    // Always await any lingering turn promise, even if handleInterrupt() already ran
    if (this.currentTurnPromise) {
      const teardownPromise = this.currentTurnPromise;
      this.currentTurnPromise = null;
      await Promise.race([
        teardownPromise.catch(() => {}),
        new Promise<void>(resolve => setTimeout(resolve, 2000)),
      ]);
    }

    this.state = 'processing';
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
   * Called when the user (in the chat UI) answers a pending question.
   */
  async handleUserAnswer(answerText: string): Promise<boolean> {
    if (this.state !== 'waiting_on_user') {
      log.warn(
        { callSessionId: this.callSessionId, state: this.state },
        'handleUserAnswer called but controller is not in waiting_on_user state',
      );
      return false;
    }

    // Clear the consultation timeout
    if (this.consultationTimer) {
      clearTimeout(this.consultationTimer);
      this.consultationTimer = null;
    }

    // Defensive: await any lingering turn promise before starting a new one.
    if (this.currentTurnPromise) {
      const teardownPromise = this.currentTurnPromise;
      this.currentTurnPromise = null;
      await Promise.race([
        teardownPromise.catch(() => {}),
        new Promise<void>(resolve => setTimeout(resolve, 2000)),
      ]);
    }

    this.state = 'processing';
    updateCallSession(this.callSessionId, { status: 'in_progress' });

    // Merge any instructions that were queued during the waiting_on_user
    // state into a single user message alongside the answer to avoid
    // consecutive user-role messages (which violate API role-alternation
    // requirements).
    const parts: string[] = [];
    for (const instr of this.pendingInstructions) {
      parts.push(`[USER_INSTRUCTION: ${instr}]`);
    }
    this.pendingInstructions = [];
    parts.push(`[USER_ANSWERED: ${answerText}]`);

    const content = parts.join('\n');

    // Fire-and-forget: unblock the caller so the HTTP response and answer
    // persistence happen immediately, before LLM streaming begins.
    this.runTurn(content)
      .then(() => this.drainPendingCallerUtterances())
      .catch((err) =>
        log.error({ err, callSessionId: this.callSessionId }, 'runTurn failed after user answer'),
      );
    return true;
  }

  /**
   * Inject a user instruction into the controller's conversation.
   * The instruction is formatted as a dedicated marker that the system prompt
   * tells the model to treat as high-priority steering input.
   *
   * When the LLM is actively processing or speaking, or when the controller
   * is waiting on a user answer, the instruction is queued and spliced into
   * the conversation at the correct chronological position once the current
   * turn completes.
   */
  async handleUserInstruction(instructionText: string): Promise<void> {
    recordCallEvent(this.callSessionId, 'user_instruction_relayed', { instruction: instructionText });

    // Queue the instruction when it cannot be safely appended right now
    if (this.state === 'processing' || this.state === 'speaking' || this.state === 'waiting_on_user') {
      this.pendingInstructions.push(instructionText);
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
    const wasSpeaking = this.state === 'speaking';
    this.abortCurrentTurn();
    this.llmRunVersion++;
    // Explicitly terminate the in-progress TTS turn so the relay can
    // immediately hand control back to the caller after barge-in.
    if (wasSpeaking) {
      this.relay.sendTextToken('', true);
    }
    this.state = 'idle';
  }

  /**
   * Tear down all timers and abort any in-flight work.
   */
  destroy(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.durationTimer) clearTimeout(this.durationTimer);
    if (this.durationWarningTimer) clearTimeout(this.durationWarningTimer);
    if (this.consultationTimer) clearTimeout(this.consultationTimer);
    if (this.durationEndTimer) { clearTimeout(this.durationEndTimer); this.durationEndTimer = null; }
    this.llmRunVersion++;
    this.abortCurrentTurn();
    this.currentTurnPromise = null;
    unregisterCallController(this.callSessionId);
    log.info({ callSessionId: this.callSessionId }, 'CallController destroyed');
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

  private formatCallerUtterance(transcript: string, speaker?: PromptSpeakerContext): string {
    if (!speaker) return transcript;
    const safeId = speaker.speakerId.replaceAll('"', '\'');
    const safeLabel = speaker.speakerLabel.replaceAll('"', '\'');
    const confidencePart = speaker.speakerConfidence != null ? ` confidence="${speaker.speakerConfidence.toFixed(2)}"` : '';
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
      this.state = 'speaking';

      // Buffer incoming tokens so we can strip control markers ([ASK_GUARDIAN:...], [END_CALL])
      // before they reach TTS. We hold text whenever an unmatched '[' appears, since it
      // could be the start of a control marker.
      let ttsBuffer = '';
      // Accumulate the full response text for post-turn marker detection
      let fullResponseText = '';

      const flushSafeText = (): void => {
        if (!this.isCurrentRun(runVersion)) return;
        if (ttsBuffer.length === 0) return;
        const bracketIdx = ttsBuffer.indexOf('[');
        if (bracketIdx === -1) {
          // No bracket at all — safe to flush everything
          this.relay.sendTextToken(ttsBuffer, false);
          ttsBuffer = '';
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
          const couldBeControl =
            '[ASK_GUARDIAN:'.startsWith(afterBracket) ||
            '[USER_ANSWERED:'.startsWith(afterBracket) ||
            '[USER_INSTRUCTION:'.startsWith(afterBracket) ||
            '[CALL_OPENING]'.startsWith(afterBracket) ||
            '[CALL_OPENING_ACK]'.startsWith(afterBracket) ||
            '[END_CALL]'.startsWith(afterBracket) ||
            afterBracket.startsWith('[ASK_GUARDIAN:') ||
            afterBracket.startsWith('[USER_ANSWERED:') ||
            afterBracket.startsWith('[USER_INSTRUCTION:') ||
            afterBracket === '[CALL_OPENING' ||
            afterBracket.startsWith('[CALL_OPENING]') ||
            afterBracket === '[CALL_OPENING_ACK' ||
            afterBracket.startsWith('[CALL_OPENING_ACK]') ||
            afterBracket === '[END_CALL' ||
            afterBracket.startsWith('[END_CALL]');

          if (!couldBeControl) {
            // Not a control marker prefix — flush up to the next '[' (if any)
            const nextBracket = ttsBuffer.indexOf('[', 1);
            if (nextBracket === -1) {
              this.relay.sendTextToken(ttsBuffer, false);
              ttsBuffer = '';
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
          content,
          assistantId: this.assistantId,
          guardianContext: this.guardianContext ?? undefined,
          isInbound: this.isInbound,
          task: this.task,
          onTextDelta,
          onComplete,
          onError,
          signal: runSignal,
        }).then((handle) => {
          if (this.isCurrentRun(runVersion)) {
            this.currentTurnHandle = handle;
          } else {
            // Turn was superseded before handle arrived; abort immediately
            handle.abort();
          }
        }).catch((err) => {
          reject(err);
        });

        // Defensive: if the turn is aborted (e.g. barge-in) and the event
        // sink callbacks are never invoked, resolve the promise so it
        // doesn't hang forever.
        runSignal.addEventListener('abort', () => { resolve(); }, { once: true });
      });

      await turnComplete;
      if (!this.isCurrentRun(runVersion)) return;

      // Final sweep: strip any remaining control markers from the buffer
      ttsBuffer = stripInternalSpeechMarkers(ttsBuffer);
      if (ttsBuffer.length > 0) {
        this.relay.sendTextToken(ttsBuffer, false);
      }

      // Signal end of this turn's speech
      this.relay.sendTextToken('', true);

      // Mark the greeting's first response as awaiting ack
      if (this.lastSentWasOpener && fullResponseText.length > 0) {
        this.awaitingOpeningAck = true;
        this.lastSentWasOpener = false;
      }

      const responseText = fullResponseText;

      // Record the assistant response event
      recordCallEvent(this.callSessionId, 'assistant_spoke', { text: responseText });
      const spokenText = stripInternalSpeechMarkers(responseText).trim();
      if (spokenText.length > 0) {
        const session = getCallSession(this.callSessionId);
        if (session) {
          fireCallTranscriptNotifier(session.conversationId, this.callSessionId, 'assistant', spokenText);
        }
      }

      // Check for ASK_GUARDIAN pattern
      const askMatch = responseText.match(ASK_GUARDIAN_CAPTURE_REGEX);
      if (askMatch) {
        const questionText = askMatch[1];
        const pendingQuestion = createPendingQuestion(this.callSessionId, questionText);
        this.state = 'waiting_on_user';
        updateCallSession(this.callSessionId, { status: 'waiting_on_user' });
        recordCallEvent(this.callSessionId, 'user_question_asked', { question: questionText });

        // Notify the conversation that a question was asked
        const session = getCallSession(this.callSessionId);
        if (session) {
          fireCallQuestionNotifier(session.conversationId, this.callSessionId, questionText);

          // Dispatch guardian action request to all configured channels
          void dispatchGuardianQuestion({
            callSessionId: this.callSessionId,
            conversationId: session.conversationId,
            assistantId: this.assistantId,
            pendingQuestion,
            broadcast: this.broadcast,
          });
        }

        // Set a consultation timeout
        this.consultationTimer = setTimeout(() => {
          if (this.state === 'waiting_on_user') {
            log.info({ callSessionId: this.callSessionId }, 'User consultation timed out');
            this.relay.sendTextToken(
              'I\'m sorry, I wasn\'t able to get that information in time. Let me move on.',
              true,
            );
            this.state = 'idle';
            updateCallSession(this.callSessionId, { status: 'in_progress' });
            expirePendingQuestions(this.callSessionId);
            this.flushPendingInstructions();
            this.drainPendingCallerUtterances();
          }
        }, getUserConsultationTimeoutMs());
        return;
      }

      // Check for END_CALL marker
      if (responseText.includes(END_CALL_MARKER)) {
        const currentSession = getCallSession(this.callSessionId);
        const shouldNotifyCompletion = currentSession
          ? currentSession.status !== 'completed' && currentSession.status !== 'failed' && currentSession.status !== 'cancelled'
          : false;

        this.relay.endSession('Call completed');
        updateCallSession(this.callSessionId, { status: 'completed', endedAt: Date.now() });
        recordCallEvent(this.callSessionId, 'call_ended', { reason: 'completed' });

        // Notify the voice conversation
        if (shouldNotifyCompletion && currentSession) {
          persistCallCompletionMessage(currentSession.conversationId, this.callSessionId);
          fireCallCompletionNotifier(currentSession.conversationId, this.callSessionId);
        }

        // Post a pointer message in the initiating conversation
        if (currentSession?.initiatedFromConversationId) {
          const durationMs = currentSession.startedAt ? Date.now() - currentSession.startedAt : 0;
          addPointerMessage(currentSession.initiatedFromConversationId, 'completed', currentSession.toNumber, {
            duration: durationMs > 0 ? formatDuration(durationMs) : undefined,
          });
        }
        this.state = 'idle';
        return;
      }

      // Normal turn complete — restart silence detection and flush any
      // instructions that arrived while the LLM was active.
      this.state = 'idle';
      this.currentTurnHandle = null;
      this.resetSilenceTimer();
      this.flushPendingInstructions();
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
          'Voice turn aborted',
        );
        if (this.isCurrentRun(runVersion)) {
          this.state = 'idle';
          this.resetSilenceTimer();
        }
        return;
      }
      if (!this.isCurrentRun(runVersion)) {
        log.debug(
          { callSessionId: this.callSessionId, errName: err instanceof Error ? err.name : typeof err },
          'Ignoring stale voice turn error from superseded turn',
        );
        return;
      }
      log.error({ err, callSessionId: this.callSessionId }, 'Voice turn error');
      this.relay.sendTextToken('I\'m sorry, I encountered a technical issue. Could you repeat that?', true);
      this.state = 'idle';
      this.resetSilenceTimer();
      this.flushPendingInstructions();
    }
  }

  private isExpectedAbortError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return err.name === 'AbortError'
      || err.name === 'APIUserAbortError'
      || err.message === 'Session is already processing a message';
  }

  private isCurrentRun(runVersion: number): boolean {
    return runVersion === this.llmRunVersion;
  }

  /**
   * Drain any instructions that were queued while the LLM was active.
   */
  private flushPendingInstructions(): void {
    if (this.pendingInstructions.length === 0) return;

    const parts = this.pendingInstructions.map(
      (instr) => `[USER_INSTRUCTION: ${instr}]`,
    );
    this.pendingInstructions = [];

    const content = parts.join('\n');

    this.resetSilenceTimer();

    // Fire-and-forget so we don't block the current turn's cleanup.
    this.runTurn(content).catch((err) =>
      log.error({ err, callSessionId: this.callSessionId }, 'runTurn failed after flushing queued instructions'),
    );
  }

  /**
   * Drain caller utterances that were queued while waiting_on_user.
   * Only the most recent utterance is processed — older ones are discarded
   * as stale since the caller likely moved on.
   */
  private drainPendingCallerUtterances(): void {
    if (this.pendingCallerUtterances.length === 0) return;

    // Keep only the most recent utterance; discard stale older ones
    const latest = this.pendingCallerUtterances[this.pendingCallerUtterances.length - 1];
    this.pendingCallerUtterances = [];

    // Fire-and-forget so we don't block the current turn's cleanup.
    this.handleCallerUtterance(latest.transcript, latest.speaker).catch((err) =>
      log.error({ err, callSessionId: this.callSessionId }, 'runTurn failed after draining queued caller utterance'),
    );
  }

  private startDurationTimer(): void {
    const maxDurationMs = getMaxCallDurationMs();
    const warningMs = maxDurationMs - 2 * 60 * 1000; // 2 minutes before max

    if (warningMs > 0) {
      this.durationWarningTimer = setTimeout(() => {
        log.info({ callSessionId: this.callSessionId }, 'Call duration warning');
        this.relay.sendTextToken(
          'Just to let you know, we\'re running low on time for this call.',
          true,
        );
      }, warningMs);
    }

    this.durationTimer = setTimeout(() => {
      log.info({ callSessionId: this.callSessionId }, 'Call duration limit reached');
      this.relay.sendTextToken(
        'I\'m sorry, but we\'ve reached the maximum time for this call. Thank you for your time. Goodbye!',
        true,
      );
      // Give TTS a moment to play, then end
      this.durationEndTimer = setTimeout(() => {
        const currentSession = getCallSession(this.callSessionId);
        const shouldNotifyCompletion = currentSession
          ? currentSession.status !== 'completed' && currentSession.status !== 'failed' && currentSession.status !== 'cancelled'
          : false;

        this.relay.endSession('Maximum call duration reached');
        updateCallSession(this.callSessionId, { status: 'completed', endedAt: Date.now() });
        recordCallEvent(this.callSessionId, 'call_ended', { reason: 'max_duration' });
        if (shouldNotifyCompletion && currentSession) {
          persistCallCompletionMessage(currentSession.conversationId, this.callSessionId);
          fireCallCompletionNotifier(currentSession.conversationId, this.callSessionId);
        }

        // Post a pointer message in the initiating conversation
        if (currentSession?.initiatedFromConversationId) {
          const durationMs = currentSession.startedAt ? Date.now() - currentSession.startedAt : 0;
          addPointerMessage(currentSession.initiatedFromConversationId, 'completed', currentSession.toNumber, {
            duration: durationMs > 0 ? formatDuration(durationMs) : undefined,
          });
        }
      }, 3000);
    }, maxDurationMs);
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      log.info({ callSessionId: this.callSessionId }, 'Silence timeout triggered');
      this.relay.sendTextToken('Are you still there?', true);
    }, SILENCE_TIMEOUT_MS);
  }
}

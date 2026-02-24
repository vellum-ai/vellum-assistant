/**
 * LLM-driven call orchestrator.
 *
 * Manages the conversation loop for an active phone call: receives caller
 * utterances, sends them to Claude via the Anthropic streaming API, and
 * streams text tokens back through the RelayConnection for real-time TTS.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config/loader.js';
import { resolveUserReference } from '../config/user-reference.js';
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
import { registerCallOrchestrator, unregisterCallOrchestrator, fireCallQuestionNotifier, fireCallCompletionNotifier, fireCallTranscriptNotifier } from './call-state.js';
import type { PromptSpeakerContext } from './speaker-identification.js';
import { addPointerMessage, formatDuration } from './call-pointer-messages.js';
import { persistCallCompletionMessage } from './call-conversation-messages.js';
import * as conversationStore from '../memory/conversation-store.js';
import { dispatchGuardianQuestion } from './guardian-dispatch.js';
import type { ServerMessage } from '../daemon/ipc-contract.js';

const log = getLogger('call-orchestrator');

type OrchestratorState = 'idle' | 'processing' | 'waiting_on_user' | 'speaking';

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

export class CallOrchestrator {
  private callSessionId: string;
  private relay: RelayConnection;
  private state: OrchestratorState = 'idle';
  private conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private abortController: AbortController = new AbortController();
  private callStartTime: number = Date.now();
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private durationWarningTimer: ReturnType<typeof setTimeout> | null = null;
  private consultationTimer: ReturnType<typeof setTimeout> | null = null;
  private durationEndTimer: ReturnType<typeof setTimeout> | null = null;
  private task: string | null;
  /** Instructions queued while an LLM turn is in-flight or during waiting_on_user */
  private pendingInstructions: string[] = [];
  /** Ensures the outbound-call opener is triggered at most once per call. */
  private initialGreetingStarted = false;
  /** Marks that the next caller turn should be treated as an opening acknowledgment. */
  private awaitingOpeningAck = false;
  /** Monotonic run id used to suppress stale turn side effects after interruption. */
  private llmRunVersion = 0;
  /** Optional broadcast function for emitting IPC events to connected clients. */
  private broadcast?: (msg: ServerMessage) => void;
  /** Assistant identity for scoping guardian bindings. */
  private assistantId: string;

  constructor(callSessionId: string, relay: RelayConnection, task: string | null, opts?: { broadcast?: (msg: ServerMessage) => void; assistantId?: string }) {
    this.callSessionId = callSessionId;
    this.relay = relay;
    this.task = task;
    this.broadcast = opts?.broadcast;
    this.assistantId = opts?.assistantId ?? 'self';
    this.startDurationTimer();
    this.resetSilenceTimer();
    registerCallOrchestrator(callSessionId, this);
  }

  /**
   * Returns the current orchestrator state.
   */
  getState(): OrchestratorState {
    return this.state;
  }

  /**
   * Kick off the first outbound call utterance from the assistant.
   */
  async startInitialGreeting(): Promise<void> {
    if (this.initialGreetingStarted) return;
    if (this.state !== 'idle') return;

    this.initialGreetingStarted = true;
    this.resetSilenceTimer();
    this.conversationHistory.push({ role: 'user', content: CALL_OPENING_MARKER });
    await this.runLlm();
    const lastMessage = this.conversationHistory[this.conversationHistory.length - 1];
    if (lastMessage?.role === 'assistant') {
      this.awaitingOpeningAck = true;
    }
  }

  /**
   * Handle a final caller utterance from the ConversationRelay.
   */
  async handleCallerUtterance(transcript: string, speaker?: PromptSpeakerContext): Promise<void> {
    const interruptedInFlight = this.state === 'processing' || this.state === 'speaking';
    // If we're already processing or speaking, abort the in-flight generation
    if (interruptedInFlight) {
      this.abortController.abort();
      this.abortController = new AbortController();

      // Strip the one-shot [CALL_OPENING] marker from conversation history
      // so it doesn't leak into subsequent LLM requests after barge-in.
      // Without this, the consecutive-user merge path below would append
      // the caller's transcript to the synthetic "[CALL_OPENING]" message,
      // causing the model to re-run opener behavior instead of responding
      // directly to the caller.
      // If the marker-only seed message becomes empty, remove it entirely:
      // Anthropic rejects any user turn with empty content.
      for (let i = 0; i < this.conversationHistory.length; i++) {
        const entry = this.conversationHistory[i];
        if (!entry.content.includes(CALL_OPENING_MARKER)) continue;
        const stripped = entry.content.replace(CALL_OPENING_MARKER_REGEX, '').trim();
        if (stripped.length === 0) {
          this.conversationHistory.splice(i, 1);
          i--;
        } else {
          entry.content = stripped;
        }
      }
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

    // Preserve strict role alternation for Anthropic. If the last message
    // is already user-role (e.g. interrupted run never appended assistant,
    // or a second caller prompt arrives before assistant completion), merge
    // this utterance into that same user turn.
    const lastMessage = this.conversationHistory[this.conversationHistory.length - 1];
    if (lastMessage?.role === 'user') {
      const existingContent = lastMessage.content.trim();
      lastMessage.content = existingContent.length > 0
        ? `${lastMessage.content}\n${callerTurnContent}`
        : callerTurnContent;
    } else {
      this.conversationHistory.push({
        role: 'user',
        content: callerTurnContent,
      });
    }

    await this.runLlm();
  }

  /**
   * Called when the user (in the chat UI) answers a pending question.
   */
  async handleUserAnswer(answerText: string): Promise<boolean> {
    if (this.state !== 'waiting_on_user') {
      log.warn(
        { callSessionId: this.callSessionId, state: this.state },
        'handleUserAnswer called but orchestrator is not in waiting_on_user state',
      );
      return false;
    }

    // Clear the consultation timeout
    if (this.consultationTimer) {
      clearTimeout(this.consultationTimer);
      this.consultationTimer = null;
    }

    this.state = 'processing';
    updateCallSession(this.callSessionId, { status: 'in_progress' });

    // Merge any instructions that were queued during the waiting_on_user
    // state into a single user message alongside the answer to avoid
    // consecutive user-role messages (which violate Anthropic API
    // role-alternation requirements).
    const parts: string[] = [];
    for (const instr of this.pendingInstructions) {
      parts.push(`[USER_INSTRUCTION: ${instr}]`);
    }
    this.pendingInstructions = [];
    parts.push(`[USER_ANSWERED: ${answerText}]`);

    this.conversationHistory.push({ role: 'user', content: parts.join('\n') });

    // Fire-and-forget: unblock the caller so the HTTP response and answer
    // persistence happen immediately, before LLM streaming begins.
    this.runLlm().catch((err) =>
      log.error({ err, callSessionId: this.callSessionId }, 'runLlm failed after user answer'),
    );
    return true;
  }

  /**
   * Inject a user instruction into the orchestrator's conversation history.
   * The instruction is formatted as a dedicated marker that the system prompt
   * tells the model to treat as high-priority steering input.
   *
   * When the LLM is actively processing or speaking, or when the orchestrator
   * is waiting on a user answer, the instruction is queued and spliced into
   * the conversation at the correct chronological position once the current
   * turn completes. This prevents:
   *  - History ordering corruption (instruction appearing before an in-flight
   *    assistant response).
   *  - Consecutive user-role messages (which violate Anthropic API
   *    role-alternation requirements).
   */
  async handleUserInstruction(instructionText: string): Promise<void> {
    recordCallEvent(this.callSessionId, 'user_instruction_relayed', { instruction: instructionText });

    // Queue the instruction when it cannot be safely appended right now:
    //  - processing/speaking: an LLM turn is in-flight; appending would
    //    place the instruction before the assistant response in the array.
    //  - waiting_on_user: the last message is an assistant turn; the next
    //    message should be the user's answer. Queued instructions are merged
    //    into that answer message by handleUserAnswer().
    if (this.state === 'processing' || this.state === 'speaking' || this.state === 'waiting_on_user') {
      this.pendingInstructions.push(instructionText);
      return;
    }

    this.conversationHistory.push({
      role: 'user',
      content: `[USER_INSTRUCTION: ${instructionText}]`,
    });

    // Reset the silence timer so the instruction-triggered LLM turn
    // doesn't race with a stale silence timeout.
    this.resetSilenceTimer();

    await this.runLlm();
  }

  /**
   * Handle caller interrupting the assistant's speech.
   */
  handleInterrupt(): void {
    const wasSpeaking = this.state === 'speaking';
    this.abortController.abort();
    this.abortController = new AbortController();
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
    this.abortController.abort();
    unregisterCallOrchestrator(this.callSessionId);
    log.info({ callSessionId: this.callSessionId }, 'CallOrchestrator destroyed');
  }

  // ── Private ──────────────────────────────────────────────────────

  private buildSystemPrompt(): string {
    const config = getConfig();
    const disclosureRule = config.calls.disclosure.enabled
      ? `1. ${config.calls.disclosure.text}`
      : '1. Begin the conversation naturally.';

    return [
      `You are on a live phone call on behalf of ${resolveUserReference()}.`,
      this.task ? `Task: ${this.task}` : '',
      '',
      'You are speaking directly to the person who answered the phone.',
      'Respond naturally and conversationally — speak as you would in a real phone conversation.',
      '',
      'IMPORTANT RULES:',
      '0. When introducing yourself, refer to yourself as an assistant. Avoid the phrase "AI assistant" unless directly asked.',
      disclosureRule,
      '2. Be concise — phone conversations should be brief and natural.',
      '3. If the callee asks something you don\'t know, include [ASK_GUARDIAN: your question here] in your response along with a hold message like "Let me check on that for you."',
      '4. If the callee provides information preceded by [USER_ANSWERED: ...], use that answer naturally in the conversation.',
      '5. If you see [USER_INSTRUCTION: ...], treat it as a high-priority steering directive from your user. Follow the instruction immediately, adjusting your approach or response accordingly.',
      '6. When the call\'s purpose is fulfilled, include [END_CALL] in your response along with a polite goodbye.',
      '7. Do not make up information — ask the user if unsure.',
      '8. Keep responses short — 1-3 sentences is ideal for phone conversation.',
      '9. When caller text includes [SPEAKER id="..." label="..."], treat each speaker as a distinct person and personalize responses using that speaker\'s prior context in this call.',
      '10. If the latest user turn is [CALL_OPENING], generate a natural, context-specific opener: briefly introduce yourself once as an assistant, state why you are calling using the Task context, and ask a short permission/check-in question. Vary the wording; do not use a fixed template.',
      '11. If the latest user turn includes [CALL_OPENING_ACK], treat it as the callee acknowledging your opener and continue the conversation naturally without re-introducing yourself or repeating the initial check-in question.',
      '12. Do not repeat your introduction within the same call unless the callee explicitly asks who you are.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private formatCallerUtterance(transcript: string, speaker?: PromptSpeakerContext): string {
    if (!speaker) return transcript;
    const safeId = speaker.speakerId.replaceAll('"', '\'');
    const safeLabel = speaker.speakerLabel.replaceAll('"', '\'');
    const confidencePart = speaker.speakerConfidence !== null ? ` confidence="${speaker.speakerConfidence.toFixed(2)}"` : '';
    return `[SPEAKER id="${safeId}" label="${safeLabel}" source="${speaker.source}"${confidencePart}] ${transcript}`;
  }

  /**
   * Run the LLM with the current conversation history and stream
   * the response back through the relay.
   */
  private async runLlm(): Promise<void> {
    const apiKey = getConfig().apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      log.error({ callSessionId: this.callSessionId }, 'No Anthropic API key available');
      this.relay.sendTextToken('I\'m sorry, I\'m having a technical issue. Please try again later.', true);
      this.state = 'idle';
      return;
    }

    const client = new Anthropic({ apiKey });
    const runVersion = ++this.llmRunVersion;
    const runSignal = this.abortController.signal;

    try {
      this.state = 'speaking';

      const callModel = getConfig().calls.model?.trim() || 'claude-sonnet-4-20250514';

      const stream = client.messages.stream(
        {
          model: callModel,
          max_tokens: 512,
          system: this.buildSystemPrompt(),
          messages: this.conversationHistory.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        },
        { signal: runSignal },
      );

      // Buffer incoming tokens so we can strip control markers ([ASK_GUARDIAN:...], [END_CALL])
      // before they reach TTS. We hold text whenever an unmatched '[' appears, since it
      // could be the start of a control marker.
      let ttsBuffer = '';

      const flushSafeText = (_force: boolean): void => {
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
          //
          // The check must be bidirectional:
          //  - When the buffer is shorter than the prefix (e.g. "[ASK"), the
          //    buffer is a prefix of the control tag → hold it.
          //  - When the buffer is longer than the prefix (e.g. "[ASK_GUARDIAN: what"),
          //    the buffer starts with the control tag prefix → hold it (the
          //    variable-length payload hasn't been closed yet).
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
            // so we don't accidentally flush a later partial control marker.
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

      stream.on('text', (text) => {
        if (!this.isCurrentRun(runVersion)) return;
        ttsBuffer += text;

        // Remove complete control markers before text reaches TTS.
        ttsBuffer = stripInternalSpeechMarkers(ttsBuffer);

        flushSafeText(false);
      });

      const finalMessage = await stream.finalMessage();
      if (!this.isCurrentRun(runVersion)) return;

      // Final sweep: strip any remaining control markers from the buffer
      ttsBuffer = stripInternalSpeechMarkers(ttsBuffer);
      if (ttsBuffer.length > 0) {
        this.relay.sendTextToken(ttsBuffer, false);
      }

      // Signal end of this turn's speech
      this.relay.sendTextToken('', true);

      const responseText =
        finalMessage.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('') || '';

      // Record the assistant response
      this.conversationHistory.push({ role: 'assistant', content: responseText });
      recordCallEvent(this.callSessionId, 'assistant_spoke', { text: responseText });
      const spokenText = stripInternalSpeechMarkers(responseText).trim();
      if (spokenText.length > 0) {
        const session = getCallSession(this.callSessionId);
        if (session) {
          // Persist assistant transcript to the voice conversation so it
          // survives even when no live daemon Session is listening.
          conversationStore.addMessage(
            session.conversationId,
            'assistant',
            JSON.stringify([{ type: 'text', text: spokenText }]),
          );
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

      // Normal turn complete — flush any instructions that arrived while
      // the LLM was active. They are appended after the assistant response
      // so chronological order is preserved, then a new LLM turn is started.
      this.state = 'idle';
      this.flushPendingInstructions();
    } catch (err: unknown) {
      // Aborted requests are expected (interruptions, rapid utterances)
      if (this.isExpectedAbortError(err) || runSignal.aborted) {
        log.debug(
          {
            callSessionId: this.callSessionId,
            errName: err instanceof Error ? err.name : typeof err,
            stale: !this.isCurrentRun(runVersion),
          },
          'LLM request aborted',
        );
        if (this.isCurrentRun(runVersion)) {
          this.state = 'idle';
        }
        return;
      }
      if (!this.isCurrentRun(runVersion)) {
        log.debug(
          { callSessionId: this.callSessionId, errName: err instanceof Error ? err.name : typeof err },
          'Ignoring stale LLM streaming error from superseded turn',
        );
        return;
      }
      log.error({ err, callSessionId: this.callSessionId }, 'LLM streaming error');
      this.relay.sendTextToken('I\'m sorry, I encountered a technical issue. Could you repeat that?', true);
      this.state = 'idle';
      this.flushPendingInstructions();
    }
  }

  private isExpectedAbortError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return err.name === 'AbortError' || err.name === 'APIUserAbortError';
  }

  private isCurrentRun(runVersion: number): boolean {
    return runVersion === this.llmRunVersion;
  }

  /**
   * Drain any instructions that were queued while the LLM was active.
   * Each instruction is appended as a user message (now correctly after
   * the assistant response) and a new LLM turn is kicked off to handle
   * them. Batches all pending instructions into a single user message to
   * avoid triggering multiple sequential LLM turns.
   */
  private flushPendingInstructions(): void {
    if (this.pendingInstructions.length === 0) return;

    const parts = this.pendingInstructions.map(
      (instr) => `[USER_INSTRUCTION: ${instr}]`,
    );
    this.pendingInstructions = [];

    this.conversationHistory.push({
      role: 'user',
      content: parts.join('\n'),
    });

    this.resetSilenceTimer();

    // Fire-and-forget so we don't block the current turn's cleanup.
    this.runLlm().catch((err) =>
      log.error({ err, callSessionId: this.callSessionId }, 'runLlm failed after flushing queued instructions'),
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

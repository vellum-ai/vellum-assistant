/**
 * LLM-driven call orchestrator.
 *
 * Manages the conversation loop for an active phone call: receives caller
 * utterances, sends them to Claude via the Anthropic streaming API, and
 * streams text tokens back through the RelayConnection for real-time TTS.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config/loader.js';
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
import { registerCallOrchestrator, unregisterCallOrchestrator, fireCallQuestionNotifier, fireCallCompletionNotifier } from './call-state.js';

const log = getLogger('call-orchestrator');

type OrchestratorState = 'idle' | 'processing' | 'waiting_on_user' | 'speaking';

const ASK_USER_REGEX = /\[ASK_USER:\s*(.+?)\]/;
const END_CALL_MARKER = '[END_CALL]';

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

  constructor(callSessionId: string, relay: RelayConnection, task: string | null) {
    this.callSessionId = callSessionId;
    this.relay = relay;
    this.task = task;
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
   * Handle a final caller utterance from the ConversationRelay.
   */
  async handleCallerUtterance(transcript: string): Promise<void> {
    // If we're already processing or speaking, abort the in-flight generation
    if (this.state === 'processing' || this.state === 'speaking') {
      this.abortController.abort();
      this.abortController = new AbortController();
    }

    this.state = 'processing';
    this.resetSilenceTimer();

    // Append caller utterance
    this.conversationHistory.push({ role: 'user', content: transcript });

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

    // Append the user's answer as a special message the model recognizes
    this.conversationHistory.push({ role: 'user', content: `[USER_ANSWERED: ${answerText}]` });

    // Fire-and-forget: unblock the caller so the HTTP response and answer
    // persistence happen immediately, before LLM streaming begins.
    this.runLlm().catch((err) =>
      log.error({ err, callSessionId: this.callSessionId }, 'runLlm failed after user answer'),
    );
    return true;
  }

  /**
   * Handle caller interrupting the assistant's speech.
   */
  handleInterrupt(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
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
      'You are on a live phone call on behalf of your user.',
      this.task ? `Task: ${this.task}` : '',
      '',
      'You are speaking directly to the person who answered the phone.',
      'Respond naturally and conversationally — speak as you would in a real phone conversation.',
      '',
      'IMPORTANT RULES:',
      disclosureRule,
      '2. Be concise — phone conversations should be brief and natural.',
      '3. If the callee asks something you don\'t know, include [ASK_USER: your question here] in your response along with a hold message like "Let me check on that for you."',
      '4. If the callee provides information preceded by [USER_ANSWERED: ...], use that answer naturally in the conversation.',
      '5. When the call\'s purpose is fulfilled, include [END_CALL] in your response along with a polite goodbye.',
      '6. Do not make up information — ask the user if unsure.',
      '7. Keep responses short — 1-3 sentences is ideal for phone conversation.',
    ]
      .filter(Boolean)
      .join('\n');
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

    try {
      this.state = 'speaking';

      const stream = client.messages.stream(
        {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 512,
          system: this.buildSystemPrompt(),
          messages: this.conversationHistory.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        },
        { signal: this.abortController.signal },
      );

      // Buffer incoming tokens so we can strip control markers ([ASK_USER:...], [END_CALL])
      // before they reach TTS. We hold text whenever an unmatched '[' appears, since it
      // could be the start of a control marker.
      let ttsBuffer = '';

      const flushSafeText = (_force: boolean): void => {
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
          //  - When the buffer is longer than the prefix (e.g. "[ASK_USER: what"),
          //    the buffer starts with the control tag prefix → hold it (the
          //    variable-length payload hasn't been closed yet).
          const afterBracket = ttsBuffer;
          const couldBeControl =
            '[ASK_USER:'.startsWith(afterBracket) ||
            '[END_CALL]'.startsWith(afterBracket) ||
            afterBracket.startsWith('[ASK_USER:') ||
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
        ttsBuffer += text;

        // If the buffer contains a complete control marker, strip it
        if (ASK_USER_REGEX.test(ttsBuffer)) {
          ttsBuffer = ttsBuffer.replace(ASK_USER_REGEX, '');
        }
        if (ttsBuffer.includes(END_CALL_MARKER)) {
          ttsBuffer = ttsBuffer.replace(END_CALL_MARKER, '');
        }

        flushSafeText(false);
      });

      const finalMessage = await stream.finalMessage();

      // Final sweep: strip any remaining control markers from the buffer
      ttsBuffer = ttsBuffer.replace(ASK_USER_REGEX, '').replace(END_CALL_MARKER, '');
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

      // Check for ASK_USER pattern
      const askMatch = responseText.match(ASK_USER_REGEX);
      if (askMatch) {
        const questionText = askMatch[1];
        createPendingQuestion(this.callSessionId, questionText);
        this.state = 'waiting_on_user';
        updateCallSession(this.callSessionId, { status: 'waiting_on_user' });
        recordCallEvent(this.callSessionId, 'user_question_asked', { question: questionText });

        // Notify the conversation that a question was asked
        const session = getCallSession(this.callSessionId);
        if (session) {
          fireCallQuestionNotifier(session.conversationId, this.callSessionId, questionText);
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
          }
        }, getUserConsultationTimeoutMs());
        return;
      }

      // Check for END_CALL marker
      if (responseText.includes(END_CALL_MARKER)) {
        this.relay.endSession('Call completed');
        updateCallSession(this.callSessionId, { status: 'completed', endedAt: Date.now() });
        recordCallEvent(this.callSessionId, 'call_ended', { reason: 'completed' });

        // Notify the conversation that the call completed
        const endSession = getCallSession(this.callSessionId);
        if (endSession) {
          fireCallCompletionNotifier(endSession.conversationId, this.callSessionId);
        }
        this.state = 'idle';
        return;
      }

      // Normal turn complete
      this.state = 'idle';
    } catch (err: unknown) {
      // Aborted requests are expected (interruptions, rapid utterances)
      if (err instanceof Error && err.name === 'AbortError') {
        log.debug({ callSessionId: this.callSessionId }, 'LLM request aborted');
        return;
      }
      log.error({ err, callSessionId: this.callSessionId }, 'LLM streaming error');
      this.relay.sendTextToken('I\'m sorry, I encountered a technical issue. Could you repeat that?', true);
      this.state = 'idle';
    }
  }

  private startDurationTimer(): void {
    const maxDurationMs = getMaxCallDurationMs();
    const warningMs = maxDurationMs - 2 * 60 * 1000; // 2 minutes before max

    this.durationWarningTimer = setTimeout(() => {
      log.info({ callSessionId: this.callSessionId }, 'Call duration warning');
      this.relay.sendTextToken(
        'Just to let you know, we\'re running low on time for this call.',
        true,
      );
    }, warningMs);

    this.durationTimer = setTimeout(() => {
      log.info({ callSessionId: this.callSessionId }, 'Call duration limit reached');
      this.relay.sendTextToken(
        'I\'m sorry, but we\'ve reached the maximum time for this call. Thank you for your time. Goodbye!',
        true,
      );
      // Give TTS a moment to play, then end
      this.durationEndTimer = setTimeout(() => {
        this.relay.endSession('Maximum call duration reached');
        updateCallSession(this.callSessionId, { status: 'completed', endedAt: Date.now() });
        recordCallEvent(this.callSessionId, 'call_ended', { reason: 'max_duration' });
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

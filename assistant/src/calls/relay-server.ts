/**
 * WebSocket handler for Twilio ConversationRelay protocol.
 *
 * Manages real-time voice conversations over WebSocket. Each active call
 * has a single RelayConnection instance that processes inbound messages
 * from Twilio and can send text tokens back for TTS.
 */

import type { ServerWebSocket } from 'bun';
import { randomInt } from 'node:crypto';
import { getLogger } from '../util/logger.js';
import { getConfig } from '../config/loader.js';
import {
  getCallSession,
  updateCallSession,
  recordCallEvent,
  expirePendingQuestions,
} from './call-store.js';
import { CallOrchestrator } from './call-orchestrator.js';
import { fireCallTranscriptNotifier, fireCallCompletionNotifier } from './call-state.js';
import { addPointerMessage, formatDuration } from './call-pointer-messages.js';
import { persistCallCompletionMessage } from './call-conversation-messages.js';
import * as conversationStore from '../memory/conversation-store.js';
import {
  extractPromptSpeakerMetadata,
  SpeakerIdentityTracker,
  type PromptSpeakerContext,
} from './speaker-identification.js';
import { isTerminalState } from './call-state-machine.js';

const log = getLogger('relay-server');

// ── ConversationRelay message types ──────────────────────────────────

// Messages FROM Twilio
export interface RelaySetupMessage {
  type: 'setup';
  callSid: string;
  from: string;
  to: string;
  customParameters?: Record<string, string>;
}

export interface RelayPromptMessage {
  type: 'prompt';
  voicePrompt: string;
  lang: string;
  last: boolean;
  speakerId?: string;
  speakerLabel?: string;
  speakerName?: string;
  speakerConfidence?: number;
  participantId?: string;
  participant?: {
    id?: string;
    name?: string;
  };
  speaker?: {
    id?: string;
    label?: string;
    name?: string;
    confidence?: number;
  };
  metadata?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
}

export interface RelayInterruptMessage {
  type: 'interrupt';
  utteranceUntilInterrupt: string;
}

export interface RelayDtmfMessage {
  type: 'dtmf';
  digit: string;
}

export interface RelayErrorMessage {
  type: 'error';
  description: string;
}

export type RelayInboundMessage =
  | RelaySetupMessage
  | RelayPromptMessage
  | RelayInterruptMessage
  | RelayDtmfMessage
  | RelayErrorMessage;

// Messages TO Twilio
export interface RelayTextMessage {
  type: 'text';
  token: string;
  last: boolean;
}

export interface RelayEndMessage {
  type: 'end';
  handoffData?: string;
}

// ── WebSocket data type ──────────────────────────────────────────────

export interface RelayWebSocketData {
  callSessionId: string;
}

// ── Module-level state ───────────────────────────────────────────────

/** Active relay connections keyed by callSessionId. */
export const activeRelayConnections = new Map<string, RelayConnection>();

/** Module-level broadcast function, set by the HTTP server during startup. */
let globalBroadcast: ((msg: import('../daemon/ipc-contract.js').ServerMessage) => void) | undefined;

/** Register a broadcast function so RelayConnection can forward IPC events. */
export function setRelayBroadcast(fn: (msg: import('../daemon/ipc-contract.js').ServerMessage) => void): void {
  globalBroadcast = fn;
}

// ── RelayConnection ──────────────────────────────────────────────────

/**
 * Manages a single WebSocket connection for one call.
 */
export type RelayConnectionState = 'connected' | 'verification_pending';

export class RelayConnection {
  private ws: ServerWebSocket<RelayWebSocketData>;
  private callSessionId: string;
  private conversationHistory: Array<{
    role: 'caller' | 'assistant';
    text: string;
    timestamp: number;
    speaker?: PromptSpeakerContext;
  }>;
  private abortController: AbortController;
  private orchestrator: CallOrchestrator | null = null;
  private speakerIdentityTracker: SpeakerIdentityTracker;

  // Verification state
  private connectionState: RelayConnectionState = 'connected';
  private verificationCode: string | null = null;
  private verificationAttempts = 0;
  private verificationMaxAttempts = 3;
  private verificationCodeLength = 6;
  private dtmfBuffer = '';

  constructor(ws: ServerWebSocket<RelayWebSocketData>, callSessionId: string) {
    this.ws = ws;
    this.callSessionId = callSessionId;
    this.conversationHistory = [];
    this.abortController = new AbortController();
    this.speakerIdentityTracker = new SpeakerIdentityTracker();
  }

  /**
   * Get the verification code for this connection (if verification is active).
   */
  getVerificationCode(): string | null {
    return this.verificationCode;
  }

  /**
   * Handle an inbound message from Twilio via the ConversationRelay WebSocket.
   */
  async handleMessage(data: string): Promise<void> {
    let parsed: RelayInboundMessage;
    try {
      parsed = JSON.parse(data) as RelayInboundMessage;
    } catch {
      log.warn({ callSessionId: this.callSessionId, data }, 'Failed to parse relay message');
      return;
    }

    switch (parsed.type) {
      case 'setup':
        await this.handleSetup(parsed);
        break;
      case 'prompt':
        await this.handlePrompt(parsed);
        break;
      case 'interrupt':
        this.handleInterrupt(parsed);
        break;
      case 'dtmf':
        this.handleDtmf(parsed);
        break;
      case 'error':
        this.handleError(parsed);
        break;
      default:
        log.warn({ callSessionId: this.callSessionId, type: (parsed as Record<string, unknown>).type }, 'Unknown relay message type');
    }
  }

  /**
   * Send a text token to the caller for TTS playback.
   */
  sendTextToken(token: string, last: boolean): void {
    const message: RelayTextMessage = { type: 'text', token, last };
    try {
      this.ws.send(JSON.stringify(message));
    } catch (err) {
      log.error({ err, callSessionId: this.callSessionId }, 'Failed to send text token');
    }
  }

  /**
   * End the ConversationRelay session.
   */
  endSession(reason?: string): void {
    const message: RelayEndMessage = { type: 'end' };
    if (reason) {
      message.handoffData = JSON.stringify({ reason });
    }
    try {
      this.ws.send(JSON.stringify(message));
    } catch (err) {
      log.error({ err, callSessionId: this.callSessionId }, 'Failed to send end message');
    }
  }

  /**
   * Get the conversation history for context.
   */
  getConversationHistory(): Array<{ role: string; text: string; speaker?: PromptSpeakerContext }> {
    return this.conversationHistory.map(({ role, text, speaker }) => ({ role, text, speaker }));
  }

  /**
   * Get the call session ID for this connection.
   */
  getCallSessionId(): string {
    return this.callSessionId;
  }

  /**
   * Set the orchestrator for this connection.
   */
  setOrchestrator(orchestrator: CallOrchestrator): void {
    this.orchestrator = orchestrator;
  }

  /**
   * Get the orchestrator for this connection.
   */
  getOrchestrator(): CallOrchestrator | null {
    return this.orchestrator;
  }

  /**
   * Clean up resources on disconnect.
   */
  destroy(): void {
    if (this.orchestrator) {
      this.orchestrator.destroy();
      this.orchestrator = null;
    }
    this.abortController.abort();
    log.info({ callSessionId: this.callSessionId }, 'RelayConnection destroyed');
  }

  /**
   * Handle transport-level close from the relay websocket.
   *
   * Twilio status callbacks are best-effort; if they are delayed or absent,
   * we still finalize the call lifecycle from the relay close signal.
   */
  handleTransportClosed(code?: number, reason?: string): void {
    const session = getCallSession(this.callSessionId);
    if (!session) return;
    if (isTerminalState(session.status)) return;

    const isNormalClose = code === 1000;
    if (isNormalClose) {
      updateCallSession(this.callSessionId, {
        status: 'completed',
        endedAt: Date.now(),
      });
      recordCallEvent(this.callSessionId, 'call_ended', {
        reason: reason || 'relay_closed',
        closeCode: code,
      });

      // Post a pointer message in the initiating conversation
      if (session.initiatedFromConversationId) {
        const durationMs = session.startedAt ? Date.now() - session.startedAt : 0;
        addPointerMessage(session.initiatedFromConversationId, 'completed', session.toNumber, {
          duration: durationMs > 0 ? formatDuration(durationMs) : undefined,
        });
      }
    } else {
      const detail = reason || (code ? `relay_closed_${code}` : 'relay_closed_abnormal');
      updateCallSession(this.callSessionId, {
        status: 'failed',
        endedAt: Date.now(),
        lastError: `Relay websocket closed unexpectedly: ${detail}`,
      });
      recordCallEvent(this.callSessionId, 'call_failed', {
        reason: detail,
        closeCode: code,
      });

      // Post a failure pointer message in the initiating conversation
      if (session.initiatedFromConversationId) {
        addPointerMessage(session.initiatedFromConversationId, 'failed', session.toNumber, {
          reason: detail,
        });
      }
    }

    expirePendingQuestions(this.callSessionId);
    persistCallCompletionMessage(session.conversationId, this.callSessionId);
    fireCallCompletionNotifier(session.conversationId, this.callSessionId);
  }

  // ── Private handlers ─────────────────────────────────────────────

  private async handleSetup(msg: RelaySetupMessage): Promise<void> {
    log.info(
      { callSessionId: this.callSessionId, callSid: msg.callSid, from: msg.from, to: msg.to },
      'ConversationRelay setup received',
    );

    // Store the callSid association on the call session
    const session = getCallSession(this.callSessionId);
    if (session) {
      const updates: Parameters<typeof updateCallSession>[1] = {
        providerCallSid: msg.callSid,
      };
      if (!isTerminalState(session.status) && session.status !== 'in_progress' && session.status !== 'waiting_on_user') {
        updates.status = 'in_progress';
        if (!session.startedAt) {
          updates.startedAt = Date.now();
        }
      }
      updateCallSession(this.callSessionId, updates);
    }

    recordCallEvent(this.callSessionId, 'call_connected', {
      callSid: msg.callSid,
      from: msg.from,
      to: msg.to,
      customParameters: msg.customParameters,
    });

    // Create and attach the LLM-driven orchestrator
    const orchestrator = new CallOrchestrator(this.callSessionId, this, session?.task ?? null, {
      broadcast: globalBroadcast,
      assistantId: session?.assistantId ?? 'self',
    });
    this.setOrchestrator(orchestrator);

    // Inbound calls (no task) skip callee verification — verification is
    // an outbound-call concern where we need to confirm the callee's identity.
    const isInbound = !session?.task;

    const config = getConfig();
    const verificationConfig = config.calls.verification;
    if (!isInbound && verificationConfig.enabled) {
      this.startVerification(session, verificationConfig);
    } else {
      // Skip the LLM-driven opener when a static welcome greeting is already
      // configured via CALL_WELCOME_GREETING — Twilio's ConversationRelay will
      // speak it at the transport level, so firing the orchestrator opener too
      // would cause a double greeting.
      const hasStaticGreeting = !!process.env.CALL_WELCOME_GREETING?.trim();
      if (!hasStaticGreeting) {
        orchestrator.startInitialGreeting().catch((err) =>
          log.error({ err, callSessionId: this.callSessionId }, `Failed to start initial ${isInbound ? 'inbound' : 'outbound'} greeting`),
        );
      }
    }
  }

  /**
   * Generate a verification code and prompt the callee to enter it via DTMF.
   */
  private startVerification(
    session: ReturnType<typeof getCallSession>,
    verificationConfig: { maxAttempts: number; codeLength: number },
  ): void {
    this.verificationMaxAttempts = verificationConfig.maxAttempts;
    this.verificationCodeLength = verificationConfig.codeLength;
    this.verificationAttempts = 0;
    this.dtmfBuffer = '';

    // Generate a random numeric code
    const maxValue = Math.pow(10, this.verificationCodeLength);
    const code = randomInt(0, maxValue).toString().padStart(this.verificationCodeLength, '0');
    this.verificationCode = code;
    this.connectionState = 'verification_pending';

    recordCallEvent(this.callSessionId, 'callee_verification_started', {
      codeLength: this.verificationCodeLength,
      maxAttempts: this.verificationMaxAttempts,
    });

    // Send a TTS prompt with the code spoken digit by digit
    const spokenCode = code.split('').join('. ');
    this.sendTextToken(`Please enter the verification code: ${spokenCode}.`, true);

    // Post the verification code to the initiating conversation so the
    // guardian (user) can share it with the callee.
    if (session?.initiatedFromConversationId) {
      const codeMsg = `\u{1F510} Verification code for call to ${session.toNumber}: ${code}`;
      conversationStore.addMessage(
        session.initiatedFromConversationId,
        'assistant',
        JSON.stringify([{ type: 'text', text: codeMsg }]),
      );
    }

    log.info(
      { callSessionId: this.callSessionId, codeLength: this.verificationCodeLength },
      'Callee verification started',
    );
  }

  private async handlePrompt(msg: RelayPromptMessage): Promise<void> {
    if (!msg.last) {
      // Partial transcript, wait for final
      return;
    }

    // During verification, ignore voice prompts — the callee should be
    // entering DTMF digits, not speaking.
    if (this.connectionState === 'verification_pending') {
      log.debug({ callSessionId: this.callSessionId }, 'Ignoring voice prompt during verification');
      return;
    }

    log.info(
      { callSessionId: this.callSessionId, transcript: msg.voicePrompt, lang: msg.lang },
      'Caller transcript received (final)',
    );

    const speakerMetadata = extractPromptSpeakerMetadata(msg as unknown as Record<string, unknown>);
    const speaker = this.speakerIdentityTracker.identifySpeaker(speakerMetadata);

    // Record in conversation history
    this.conversationHistory.push({
      role: 'caller',
      text: msg.voicePrompt,
      timestamp: Date.now(),
      speaker,
    });

    // Record event
    recordCallEvent(this.callSessionId, 'caller_spoke', {
      transcript: msg.voicePrompt,
      lang: msg.lang,
      speakerId: speaker.speakerId,
      speakerLabel: speaker.speakerLabel,
      speakerConfidence: speaker.speakerConfidence,
      speakerSource: speaker.source,
    });

    const session = getCallSession(this.callSessionId);
    if (session) {
      // Persist caller transcript to the voice conversation so it survives
      // even when no live daemon Session is listening.
      conversationStore.addMessage(
        session.conversationId,
        'user',
        JSON.stringify([{ type: 'text', text: msg.voicePrompt }]),
      );
      fireCallTranscriptNotifier(session.conversationId, this.callSessionId, 'caller', msg.voicePrompt);
    }

    // Route to orchestrator for LLM-driven response
    if (this.orchestrator) {
      await this.orchestrator.handleCallerUtterance(msg.voicePrompt, speaker);
    } else {
      // Fallback if orchestrator not yet initialized
      this.sendTextToken('I\'m still setting up. Please hold.', true);
    }
  }

  private handleInterrupt(msg: RelayInterruptMessage): void {
    log.info(
      { callSessionId: this.callSessionId, utteranceUntilInterrupt: msg.utteranceUntilInterrupt },
      'Caller interrupted assistant',
    );

    // Abort any in-flight processing
    this.abortController.abort();
    this.abortController = new AbortController();

    // Notify the orchestrator of the interruption
    if (this.orchestrator) {
      this.orchestrator.handleInterrupt();
    }
  }

  private handleDtmf(msg: RelayDtmfMessage): void {
    log.info(
      { callSessionId: this.callSessionId, digit: msg.digit },
      'DTMF digit received',
    );

    recordCallEvent(this.callSessionId, 'caller_spoke', {
      dtmfDigit: msg.digit,
    });

    // If verification is pending, accumulate digits and check the code
    if (this.connectionState === 'verification_pending' && this.verificationCode) {
      this.dtmfBuffer += msg.digit;

      if (this.dtmfBuffer.length >= this.verificationCodeLength) {
        const enteredCode = this.dtmfBuffer.slice(0, this.verificationCodeLength);
        this.dtmfBuffer = '';

        if (enteredCode === this.verificationCode) {
          // Verification succeeded
          this.connectionState = 'connected';
          this.verificationCode = null;
          this.verificationAttempts = 0;

          recordCallEvent(this.callSessionId, 'callee_verification_succeeded', {});
          log.info({ callSessionId: this.callSessionId }, 'Callee verification succeeded');

          // Proceed to the normal call flow
          if (this.orchestrator) {
            this.orchestrator.startInitialGreeting().catch((err) =>
              log.error({ err, callSessionId: this.callSessionId }, 'Failed to start initial outbound greeting after verification'),
            );
          }
        } else {
          // Verification failed for this attempt
          this.verificationAttempts++;

          if (this.verificationAttempts >= this.verificationMaxAttempts) {
            // Max attempts reached — end the call
            recordCallEvent(this.callSessionId, 'callee_verification_failed', {
              attempts: this.verificationAttempts,
            });
            log.warn({ callSessionId: this.callSessionId, attempts: this.verificationAttempts }, 'Callee verification failed — max attempts reached');

            this.sendTextToken('Verification failed. Goodbye.', true);

            // Mark failed immediately so a relay close during the goodbye TTS
            // window cannot race this into a terminal "completed" status.
            updateCallSession(this.callSessionId, {
              status: 'failed',
              endedAt: Date.now(),
              lastError: 'Callee verification failed — max attempts exceeded',
            });

            const session = getCallSession(this.callSessionId);
            if (session) {
              expirePendingQuestions(this.callSessionId);
              persistCallCompletionMessage(session.conversationId, this.callSessionId);
              fireCallCompletionNotifier(session.conversationId, this.callSessionId);
              if (session.initiatedFromConversationId) {
                addPointerMessage(session.initiatedFromConversationId, 'failed', session.toNumber, {
                  reason: 'Callee verification failed',
                });
              }
            }

            // End the call with failed status after TTS plays
            setTimeout(() => {
              this.endSession('Verification failed');
            }, 2000);
          } else {
            // Allow another attempt
            log.info(
              { callSessionId: this.callSessionId, attempt: this.verificationAttempts, maxAttempts: this.verificationMaxAttempts },
              'Callee verification attempt failed — retrying',
            );
            this.sendTextToken('That code was incorrect. Please try again.', true);
          }
        }
      }
    }
  }

  private handleError(msg: RelayErrorMessage): void {
    log.error(
      { callSessionId: this.callSessionId, description: msg.description },
      'ConversationRelay error',
    );

    recordCallEvent(this.callSessionId, 'call_failed', {
      error: msg.description,
    });
  }
}

/**
 * WebSocket handler for Twilio ConversationRelay protocol.
 *
 * Manages real-time voice conversations over WebSocket. Each active call
 * has a single RelayConnection instance that processes inbound messages
 * from Twilio and can send text tokens back for TTS.
 */

import type { ServerWebSocket } from 'bun';
import { getLogger } from '../util/logger.js';
import {
  getCallSession,
  updateCallSession,
  recordCallEvent,
} from './call-store.js';
import { CallOrchestrator } from './call-orchestrator.js';
import { fireCallTranscriptNotifier } from './call-state.js';
import {
  extractPromptSpeakerMetadata,
  SpeakerIdentityTracker,
  type PromptSpeakerContext,
} from './speaker-identification.js';

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

// ── RelayConnection ──────────────────────────────────────────────────

/**
 * Manages a single WebSocket connection for one call.
 */
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

  constructor(ws: ServerWebSocket<RelayWebSocketData>, callSessionId: string) {
    this.ws = ws;
    this.callSessionId = callSessionId;
    this.conversationHistory = [];
    this.abortController = new AbortController();
    this.speakerIdentityTracker = new SpeakerIdentityTracker();
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

  // ── Private handlers ─────────────────────────────────────────────

  private async handleSetup(msg: RelaySetupMessage): Promise<void> {
    log.info(
      { callSessionId: this.callSessionId, callSid: msg.callSid, from: msg.from, to: msg.to },
      'ConversationRelay setup received',
    );

    // Store the callSid association on the call session
    const session = getCallSession(this.callSessionId);
    if (session) {
      updateCallSession(this.callSessionId, { providerCallSid: msg.callSid });
    }

    recordCallEvent(this.callSessionId, 'call_connected', {
      callSid: msg.callSid,
      from: msg.from,
      to: msg.to,
      customParameters: msg.customParameters,
    });

    // Create and attach the LLM-driven orchestrator
    const orchestrator = new CallOrchestrator(this.callSessionId, this, session?.task ?? null);
    this.setOrchestrator(orchestrator);
  }

  private async handlePrompt(msg: RelayPromptMessage): Promise<void> {
    if (!msg.last) {
      // Partial transcript, wait for final
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

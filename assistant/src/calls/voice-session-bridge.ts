/**
 * Bridge between voice relay and the daemon session pipeline.
 *
 * Provides a `startVoiceTurn()` function that manages a voice turn
 * directly through the session, translating agent-loop events into
 * simple callbacks suitable for real-time TTS streaming.
 *
 * Dependency injection follows the same module-level setter pattern used by
 * setRelayBroadcast in relay-server.ts: the daemon lifecycle injects
 * dependencies at startup via `setVoiceBridgeDeps()`.
 */

import type { ChannelId } from '../channels/types.js';
import { parseChannelId } from '../channels/types.js';
import { getConfig } from '../config/loader.js';
import type { ServerMessage } from '../daemon/ipc-protocol.js';
import type { Session } from '../daemon/session.js';
import type { GuardianRuntimeContext } from '../daemon/session-runtime-assembly.js';
import { resolveChannelCapabilities } from '../daemon/session-runtime-assembly.js';
import { checkIngressForSecrets } from '../security/secret-ingress.js';
import { IngressBlockedError } from '../util/errors.js';
import { getLogger } from '../util/logger.js';
import { buildAssistantEvent } from '../runtime/assistant-event.js';
import { assistantEventHub } from '../runtime/assistant-event-hub.js';

/**
 * Matches the exact `[CALL_OPENING]` marker that call-controller sends for
 * the initial greeting turn. We replace it with a benign content string before
 * persisting so the marker never appears in session history where it could
 * retrigger opener behavior after a barge-in interruption.
 */
const CALL_OPENING_MARKER = '[CALL_OPENING]';


const log = getLogger('voice-session-bridge');

// ---------------------------------------------------------------------------
// Module-level dependency injection
// ---------------------------------------------------------------------------

export interface VoiceBridgeDeps {
  getOrCreateSession: (conversationId: string, transport?: {
    channelId: ChannelId;
    hints?: string[];
    uxBrief?: string;
  }) => Promise<Session>;
  resolveAttachments: (attachmentIds: string[]) => Array<{
    id: string;
    filename: string;
    mimeType: string;
    data: string;
  }>;
  deriveDefaultStrictSideEffects: (conversationId: string) => boolean;
}

let deps: VoiceBridgeDeps | undefined;

/**
 * Inject dependencies from daemon lifecycle.
 * Must be called during daemon startup before any voice turns are executed.
 */
export function setVoiceBridgeDeps(d: VoiceBridgeDeps): void {
  deps = d;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Real-time event sink for voice TTS streaming. Agent-loop events are
 * forwarded here for real-time text-to-speech without modifying the
 * standard channel path.
 */
export interface VoiceRunEventSink {
  onTextDelta(text: string): void;
  onMessageComplete(): void;
  onError(message: string): void;
  onToolUse(toolName: string, input: Record<string, unknown>): void;
}

export interface VoiceTurnOptions {
  /** The conversation ID for this voice call's session. */
  conversationId: string;
  /** The transcribed caller utterance or synthetic marker. */
  content: string;
  /** Assistant scope for multi-assistant channels. */
  assistantId?: string;
  /** Guardian trust context for the caller. */
  guardianContext?: GuardianRuntimeContext;
  /** Whether this is an inbound call (no outbound task). */
  isInbound: boolean;
  /** The outbound call task, if any. */
  task?: string | null;
  /** Called for each streaming text token from the agent loop. */
  onTextDelta: (text: string) => void;
  /** Called when the agent loop completes a full response. */
  onComplete: () => void;
  /** Called when the agent loop encounters an error. */
  onError: (message: string) => void;
  /** Optional AbortSignal for external cancellation (e.g. barge-in). */
  signal?: AbortSignal;
}

export interface VoiceTurnHandle {
  /** Unique identifier for this turn. */
  turnId: string;
  /** Abort the in-flight turn (e.g. for barge-in). */
  abort: () => void;
}

// ---------------------------------------------------------------------------
// Call-control protocol prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the call-control protocol prompt injected into each voice turn.
 *
 * This contains the marker protocol rules that the model needs to emit
 * control markers during voice calls. It intentionally omits the "You are
 * on a live phone call" framing (the session system prompt already
 * provides assistant identity) and guardian context (injected separately).
 */
function buildVoiceCallControlPrompt(opts: {
  isInbound: boolean;
  task?: string | null;
  isCallerGuardian?: boolean;
}): string {
  const config = getConfig();
  const disclosureEnabled = config.calls?.disclosure?.enabled === true;
  const disclosureText = config.calls?.disclosure?.text?.trim();
  const disclosureRule = disclosureEnabled && disclosureText
    ? `0. ${disclosureText}`
    : '0. Begin the conversation naturally.';

  const lines: string[] = ['<voice_call_control>'];

  if (!opts.isInbound && opts.task) {
    lines.push(`Task: ${opts.task}`);
    lines.push('');
  }

  lines.push(
    'CALL PROTOCOL RULES:',
    disclosureRule,
    '1. Be concise — keep responses to 1-3 sentences. Phone conversations should be brief and natural.',
    ...(opts.isCallerGuardian
      ? ['2. You are speaking directly with your guardian (your user). Do NOT use [ASK_GUARDIAN:]. If you need permission, information, or confirmation, ask them directly in the conversation. They can answer you right now.']
      : ['2. You can consult your guardian at any time by including [ASK_GUARDIAN: your question here] in your response. When you do, add a natural hold message like "Let me check on that for you."']
    ),
  );

  if (opts.isInbound) {
    lines.push(
      '3. If information is provided preceded by [USER_ANSWERED: ...], use that answer naturally in the conversation.',
      '4. If you see [USER_INSTRUCTION: ...], treat it as a high-priority steering directive from your user. Follow the instruction immediately, adjusting your approach or response accordingly.',
      '5. When the caller indicates they are done or the conversation reaches a natural conclusion, include [END_CALL] in your response along with a polite goodbye.',
    );
  } else {
    lines.push(
      '3. If the callee provides information preceded by [USER_ANSWERED: ...], use that answer naturally in the conversation.',
      '4. If you see [USER_INSTRUCTION: ...], treat it as a high-priority steering directive from your user. Follow the instruction immediately, adjusting your approach or response accordingly.',
      '5. When the call\'s purpose is fulfilled, include [END_CALL] in your response along with a polite goodbye.',
    );
  }

  lines.push(
    '6. When caller text includes [SPEAKER id="..." label="..."], treat each speaker as a distinct person and personalize responses using that speaker\'s prior context in this call.',
  );

  if (opts.isInbound) {
    if (opts.isCallerGuardian) {
      lines.push(
        '7. If the latest user turn is "(call connected — deliver opening greeting)", this is your user calling you. Answer casually and briefly, like picking up a call from someone you know well. For example: "Hey!" or "What\'s up?" Do NOT introduce yourself, do NOT say you are calling on behalf of anyone, and do NOT ask how you can help in a formal way. Keep it short and natural.',
      );
    } else {
      lines.push(
        '7. If the latest user turn is "(call connected — deliver opening greeting)", greet the caller warmly and ask how you can help. Vary the wording; do not use a fixed template.',
      );
    }
    lines.push(
      '8. If the latest user turn includes [CALL_OPENING_ACK], treat it as the caller acknowledging your greeting and continue the conversation naturally.',
    );
  } else {
    const disclosureReminder = disclosureEnabled && disclosureText
      ? ' However, the disclosure text from rule 0 is separate from self-introduction and must always be included in your opening greeting, even if the Task does not mention introducing yourself.'
      : '';
    lines.push(
      `7. If the latest user turn is "(call connected — deliver opening greeting)", deliver your opening greeting based solely on the Task context above. The Task already describes how to open the call — follow it directly without adding any extra introduction on top. If the Task says to introduce yourself, do so once. If the Task does not mention introducing yourself, skip the introduction.${disclosureReminder} Vary the wording naturally; do not use a fixed template.`,
      '8. If the latest user turn includes [CALL_OPENING_ACK], treat it as the callee acknowledging your opener and continue the conversation naturally without re-introducing yourself or repeating the initial check-in question.',
    );
  }

  lines.push(
    '9. After the opening greeting turn, treat the Task field as background context only — do not re-execute its instructions on subsequent turns.',
    '10. Do not make up information. If you are unsure, use [ASK_GUARDIAN: your question] to consult your guardian.',
    '</voice_call_control>',
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// startVoiceTurn
// ---------------------------------------------------------------------------

/**
 * Execute a single voice turn through the daemon session pipeline.
 *
 * Manages the session directly with voice-specific defaults:
 *   - sourceChannel: 'voice'
 *   - event sink wired to the provided callbacks
 *   - abort propagated from the returned handle
 *
 * The caller (CallController via relay-server) can use the returned handle
 * to cancel the turn on barge-in.
 */
export async function startVoiceTurn(opts: VoiceTurnOptions): Promise<VoiceTurnHandle> {
  if (!deps) {
    throw new Error('Voice bridge not initialized — setVoiceBridgeDeps() was not called');
  }

  // Block inbound content that contains secrets
  const ingressCheck = checkIngressForSecrets(opts.content);
  if (ingressCheck.blocked) {
    throw new IngressBlockedError(ingressCheck.userNotice!, ingressCheck.detectedTypes);
  }

  const eventSink: VoiceRunEventSink = {
    onTextDelta: opts.onTextDelta,
    onMessageComplete: opts.onComplete,
    onError: opts.onError,
    onToolUse: (toolName, input) => {
      log.debug({ toolName, input }, 'Voice turn tool_use event');
    },
  };

  // Voice has no interactive permission/secret UI, so apply explicit
  // per-role policies:
  // - guardian: permission prompts auto-allow (parity with guardian chat)
  // - everyone else (including unknown): fail-closed strict side-effects
  //   with auto-deny confirmations.
  const actorRole = opts.guardianContext?.actorRole;
  const isGuardian = actorRole === 'guardian';
  const forceStrictSideEffects = isGuardian ? undefined : true;

  // Replace the [CALL_OPENING] marker with a neutral instruction before
  // persisting. The marker must not appear as a user message in session
  // history — after a barge-in interruption the next turn would replay
  // the stale marker and potentially retrigger opener behavior.
  const persistedContent = opts.content === CALL_OPENING_MARKER
    ? '(call connected — deliver opening greeting)'
    : opts.content;

  // Build the call-control protocol prompt so the model knows how to emit
  // control markers (ASK_GUARDIAN, END_CALL, etc.) and recognize opener turns.
  const isCallerGuardian = opts.guardianContext?.actorRole === 'guardian';

  const voiceCallControlPrompt = buildVoiceCallControlPrompt({
    isInbound: opts.isInbound,
    task: opts.task,
    isCallerGuardian,
  });

  // Get or create the session
  const transport = {
    channelId: 'voice' as ChannelId,
  };
  const session = await deps.getOrCreateSession(opts.conversationId, transport);

  if (session.isProcessing()) {
    // Voice barge-in can race with turn teardown. Wait briefly for the
    // previous turn to finish aborting before giving up.
    const maxWaitMs = 3000;
    const pollIntervalMs = 50;
    let waited = 0;
    while (session.isProcessing() && waited < maxWaitMs) {
      if (opts.signal?.aborted) {
        throw new Error('Turn aborted while waiting for session');
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      waited += pollIntervalMs;
    }
    if (opts.signal?.aborted) {
      throw new Error('Turn aborted while waiting for session');
    }
    if (session.isProcessing()) {
      throw new Error('Session is already processing a message');
    }
  }

  // Configure session for this voice turn
  const strictSideEffects = forceStrictSideEffects
    ?? deps.deriveDefaultStrictSideEffects(opts.conversationId);
  session.memoryPolicy = {
    ...session.memoryPolicy,
    strictSideEffects,
  };
  session.setAssistantId(opts.assistantId ?? 'self');
  session.setGuardianContext(opts.guardianContext ?? null);
  session.setCommandIntent(null);
  session.setTurnChannelContext({
    userMessageChannel: 'voice',
    assistantMessageChannel: 'voice',
  });
  session.setChannelCapabilities(resolveChannelCapabilities('voice', undefined));
  session.setVoiceCallControlPrompt(voiceCallControlPrompt);

  const requestId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const messageId = session.persistUserMessage(persistedContent, [], requestId);

  // Serialized publish chain so hub subscribers observe events in order.
  let hubChain: Promise<void> = Promise.resolve();
  const publishToHub = (msg: ServerMessage): void => {
    const msgRecord = msg as unknown as Record<string, unknown>;
    const msgSessionId =
      'sessionId' in msg && typeof msgRecord.sessionId === 'string'
        ? (msgRecord.sessionId as string)
        : undefined;
    const resolvedSessionId = msgSessionId ?? opts.conversationId;
    const event = buildAssistantEvent('self', msg, resolvedSessionId);
    hubChain = (async () => {
      await hubChain;
      try {
        await assistantEventHub.publish(event);
      } catch (err) {
        log.warn({ err }, 'assistant-events hub subscriber threw during voice turn');
      }
    })();
  };

  // Hook into session to intercept confirmation_request and secret_request events.
  // Voice auto-denies/auto-allows/auto-resolves these since there's no interactive UI.
  const autoDeny = !isGuardian;
  const autoAllow = isGuardian;
  let lastError: string | null = null;
  session.updateClient((msg: ServerMessage) => {
    if (msg.type === 'confirmation_request') {
      if (autoDeny) {
        log.info(
          { turnId, toolName: msg.toolName },
          'Auto-denying confirmation request for voice turn (forceStrictSideEffects)',
        );
        session.handleConfirmationResponse(
          msg.requestId,
          'deny',
          undefined,
          undefined,
          `Permission denied for "${msg.toolName}": this voice call does not have interactive approval capabilities. Side-effect tools are not available for non-guardian voice callers. In your next assistant reply, explain briefly that this action requires guardian-level access and cannot be performed during this call.`,
        );
        publishToHub(msg);
        return;
      }
      if (autoAllow) {
        log.info(
          { turnId, toolName: msg.toolName },
          'Auto-approving confirmation request for guardian voice turn',
        );
        session.handleConfirmationResponse(
          msg.requestId,
          'allow',
          undefined,
          undefined,
          `Permission approved for "${msg.toolName}": this is a verified guardian voice call.`,
        );
        publishToHub(msg);
        return;
      }
    } else if (msg.type === 'secret_request') {
      // Voice has no secret-entry UI, so resolve immediately
      log.info(
        { turnId, service: msg.service, field: msg.field },
        'Auto-resolving secret request for voice turn (no secret-entry UI)',
      );
      session.handleSecretResponse(msg.requestId, undefined, 'store');
      publishToHub(msg);
      return;
    }
    publishToHub(msg);
  });

  // Fire-and-forget the agent loop
  const cleanup = () => {
    // Reset channel capabilities so a subsequent IPC/desktop session on the
    // same conversation is not incorrectly treated as a voice client.
    session.setChannelCapabilities(null);
    session.setGuardianContext(null);
    session.setCommandIntent(null);
    session.setAssistantId('self');
    session.setVoiceCallControlPrompt(null);
    // Reset the session's client callback to a no-op so the stale
    // closure doesn't intercept events from future turns on the same session.
    session.updateClient(() => {}, true);
  };

  void (async () => {
    try {
      await session.runAgentLoop(persistedContent, messageId, (msg: ServerMessage) => {
        if (msg.type === 'error') {
          lastError = msg.message;
        } else if (msg.type === 'session_error') {
          lastError = msg.userMessage;
        }
        publishToHub(msg);

        // Forward voice-relevant events to the real-time event sink
        if (msg.type === 'assistant_text_delta') {
          eventSink.onTextDelta(msg.text);
        } else if (msg.type === 'message_complete') {
          eventSink.onMessageComplete();
        } else if (msg.type === 'generation_cancelled') {
          // Treat cancellation as a completed turn so the voice
          // turnComplete promise settles instead of hanging forever.
          eventSink.onMessageComplete();
        } else if (msg.type === 'error') {
          eventSink.onError(msg.message);
        } else if (msg.type === 'session_error') {
          eventSink.onError(msg.userMessage);
        } else if (msg.type === 'tool_use_start') {
          eventSink.onToolUse(msg.toolName, msg.input);
        }
      });
      if (lastError) {
        log.error({ turnId, error: lastError }, 'Voice turn failed (error event from agent loop)');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, turnId }, 'Voice turn failed');
      eventSink.onError(message);
    } finally {
      cleanup();
    }
  })();

  const abortFn = () => {
    if (session.currentRequestId === requestId) {
      session.abort();
    }
  };

  // If the caller provided an external AbortSignal (e.g. from a
  // RelayConnection's AbortController), wire it to the turn's abort.
  if (opts.signal) {
    if (opts.signal.aborted) {
      abortFn();
    } else {
      opts.signal.addEventListener('abort', () => abortFn(), { once: true });
    }
  }

  return {
    turnId,
    abort: abortFn,
  };
}

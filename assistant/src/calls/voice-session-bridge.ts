/**
 * Bridge between voice relay and the daemon session/run pipeline.
 *
 * Provides a `startVoiceTurn()` function that wraps RunOrchestrator.startRun()
 * with voice-specific defaults, translating agent-loop events into simple
 * callbacks suitable for real-time TTS streaming.
 *
 * Dependency injection follows the same module-level setter pattern used by
 * setRelayBroadcast in relay-server.ts: the daemon lifecycle injects the
 * RunOrchestrator instance at startup via `setVoiceBridgeOrchestrator()`.
 */

import type { RunOrchestrator, VoiceRunEventSink } from '../runtime/run-orchestrator.js';
import type { GuardianRuntimeContext } from '../daemon/session-runtime-assembly.js';
import { getConfig } from '../config/loader.js';
import { getLogger } from '../util/logger.js';

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

let orchestrator: RunOrchestrator | undefined;

/**
 * Inject the RunOrchestrator instance from daemon lifecycle.
 * Must be called during daemon startup before any voice turns are executed.
 */
export function setVoiceBridgeOrchestrator(orch: RunOrchestrator): void {
  orchestrator = orch;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  /** The run ID for this turn. */
  runId: string;
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
    lines.push(
      '7. If the latest user turn is "(call connected — deliver opening greeting)", deliver your opening greeting based solely on the Task context above. The Task already describes how to open the call — follow it directly without adding any extra introduction on top. If the Task says to introduce yourself, do so once. If the Task does not mention introducing yourself, skip the introduction. Vary the wording naturally; do not use a fixed template.',
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
 * Wraps RunOrchestrator.startRun() with voice-specific defaults:
 *   - sourceChannel: 'voice'
 *   - eventSink wired to the provided callbacks
 *   - abort propagated from the returned handle
 *
 * The caller (CallController via relay-server) can use the returned handle
 * to cancel the turn on barge-in.
 */
export async function startVoiceTurn(opts: VoiceTurnOptions): Promise<VoiceTurnHandle> {
  if (!orchestrator) {
    throw new Error('Voice bridge not initialized — setVoiceBridgeOrchestrator() was not called');
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

  const { run, abort } = await orchestrator.startRun(
    opts.conversationId,
    persistedContent,
    undefined, // no attachments for voice
    {
      sourceChannel: 'voice',
      assistantId: opts.assistantId,
      guardianContext: opts.guardianContext,
      ...(forceStrictSideEffects ? { forceStrictSideEffects } : {}),
      voiceAutoDenyConfirmations: !isGuardian,
      voiceAutoAllowConfirmations: isGuardian,
      voiceAutoResolveSecrets: true,
      turnChannelContext: {
        userMessageChannel: 'voice',
        assistantMessageChannel: 'voice',
      },
      eventSink,
      voiceCallControlPrompt,
    },
  );

  // If the caller provided an external AbortSignal (e.g. from a
  // RelayConnection's AbortController), wire it to the run's abort.
  if (opts.signal) {
    if (opts.signal.aborted) {
      abort();
    } else {
      opts.signal.addEventListener('abort', () => abort(), { once: true });
    }
  }

  return {
    runId: run.id,
    abort,
  };
}

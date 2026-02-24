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

  // Derive forceStrictSideEffects from guardian context to match channel
  // ingress behavior: non-guardian and unverified actors always get strict
  // side effects so all side-effect tools trigger the confirmation flow.
  const actorRole = opts.guardianContext?.actorRole;
  const forceStrictSideEffects =
    actorRole === 'non-guardian' || actorRole === 'unverified_channel'
      ? true
      : undefined;

  // Replace the [CALL_OPENING] marker with a neutral instruction before
  // persisting. The marker must not appear as a user message in session
  // history — after a barge-in interruption the next turn would replay
  // the stale marker and potentially retrigger opener behavior.
  const persistedContent = opts.content === CALL_OPENING_MARKER
    ? '(call connected — deliver opening greeting)'
    : opts.content;

  const { run, abort } = await orchestrator.startRun(
    opts.conversationId,
    persistedContent,
    undefined, // no attachments for voice
    {
      sourceChannel: 'voice',
      assistantId: opts.assistantId,
      guardianContext: opts.guardianContext,
      ...(forceStrictSideEffects ? { forceStrictSideEffects, voiceAutoDenyConfirmations: true } : {}),
      turnChannelContext: {
        userMessageChannel: 'voice',
        assistantMessageChannel: 'voice',
      },
      eventSink,
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

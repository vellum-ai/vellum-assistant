/**
 * Orchestrates run lifecycle for the HTTP runtime API.
 *
 * A "run" wraps a single agent-loop execution, tracking its state through:
 *   running → needs_confirmation → running → completed | failed
 *   running → needs_secret       → running → completed | failed
 *
 * When a tool needs permission, the orchestrator intercepts the
 * confirmation_request from the session's prompter and records it in
 * the run store.  Similarly, when a tool needs a secret (e.g.
 * credential_store prompt), the orchestrator intercepts the
 * secret_request and records it.  The client can then poll the run
 * status and submit a decision or secret via the respective endpoints.
 */

import type { ChannelId, InterfaceId, TurnChannelContext, TurnInterfaceContext } from '../channels/types.js';
import { parseChannelId, parseInterfaceId } from '../channels/types.js';
import * as runsStore from '../memory/runs-store.js';
import type { Run } from '../memory/runs-store.js';
import type { Session } from '../daemon/session.js';
import type { ServerMessage } from '../daemon/ipc-protocol.js';
import { resolveChannelCapabilities } from '../daemon/session-runtime-assembly.js';
import type { GuardianRuntimeContext } from '../daemon/session-runtime-assembly.js';
import type { UserDecision } from '../permissions/types.js';
import { checkIngressForSecrets } from '../security/secret-ingress.js';
import { IngressBlockedError } from '../util/errors.js';
import { getLogger } from '../util/logger.js';
import { assistantEventHub } from './assistant-event-hub.js';
import { buildAssistantEvent } from './assistant-event.js';

const log = getLogger('run-orchestrator');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Real-time event sink for voice TTS streaming. When provided to startRun(),
 * agent-loop events are forwarded here alongside the existing assistantEventHub
 * publication. This enables voice relay to receive streaming text deltas for
 * real-time text-to-speech without modifying the standard channel path.
 */
export interface VoiceRunEventSink {
  onTextDelta(text: string): void;
  onMessageComplete(): void;
  onError(message: string): void;
  onToolUse(toolName: string, input: Record<string, unknown>): void;
}

/**
 * Handle returned by startRun() that allows callers to abort an in-flight
 * run. Used by voice barge-in to cancel the current turn without crashing
 * session state.
 */
export interface RunHandle {
  run: Run;
  abort: () => void;
}

interface PendingRunState {
  prompterRequestId: string;
  session: Session;
}

export interface RunOrchestratorDeps {
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
  /**
   * Re-derive the default `strictSideEffects` value for a conversation
   * from its thread type (e.g. private → true, standard → false).
   * Called when `forceStrictSideEffects` is not explicitly provided so
   * the session never retains a stale override from a prior run.
   */
  deriveDefaultStrictSideEffects: (conversationId: string) => boolean;
}

export interface RunStartOptions {
  /**
   * When true, forces `strictSideEffects` on the session's memory policy
   * so that all side-effect tools trigger the approval/confirmation flow,
   * even if existing allow rules would normally auto-approve them.
   * Used for non-guardian actors in guardian-gated channels.
   */
  forceStrictSideEffects?: boolean;
  /**
   * The originating channel (e.g. 'telegram', 'slack'). When provided,
   * channel capabilities are resolved for this channel instead of the
   * default 'vellum'.
   */
  sourceChannel?: ChannelId;
  /**
   * The originating interface (e.g. 'macos', 'ios', 'telegram'). When
   * provided, the session's turn interface context is set to this value
   * so interface-aware metadata flows through the agent loop.
   */
  sourceInterface?: InterfaceId;
  /**
   * Transport hints from sourceMetadata (e.g. reply-context cues).
   * Forwarded to the session so the agent loop can incorporate them.
   */
  hints?: string[];
  /**
   * Brief UX context from sourceMetadata (e.g. UI surface description).
   * Forwarded to the session so the agent loop can tailor its response.
   */
  uxBrief?: string;
  /** Assistant scope for multi-assistant channels. */
  assistantId?: string;
  /** Guardian trust/identity context for the inbound actor. */
  guardianContext?: GuardianRuntimeContext;
  /** Channel command intent metadata (e.g. Telegram /start). */
  commandIntent?: { type: string; payload?: string; languageCode?: string };
  /** Resolved channel context for this turn. */
  turnChannelContext?: TurnChannelContext;
  /**
   * When provided, agent-loop events are forwarded to this sink in real time.
   * Used by voice relay for streaming TTS token delivery.
   */
  eventSink?: VoiceRunEventSink;
  /**
   * When true, any confirmation_request from the prompter is immediately
   * auto-denied instead of being stored for client polling. Used by the
   * voice path when forceStrictSideEffects is active: the voice transport
   * has no interactive approval UI, so without this flag the run would
   * stall for the full permission timeout (300s by default).
   */
  voiceAutoDenyConfirmations?: boolean;
  /**
   * When true, confirmation_request events are auto-approved immediately.
   * Used for verified-guardian voice turns where there is no interactive
   * approval UI but parity with guardian chat permissions is required.
   */
  voiceAutoAllowConfirmations?: boolean;
  /**
   * When true, secret_request events are resolved immediately with a null
   * value so voice turns do not stall waiting for a secret-entry UI that
   * voice does not provide.
   */
  voiceAutoResolveSecrets?: boolean;
  /**
   * Call-control protocol prompt injected into each voice turn so the
   * model knows to emit control markers ([ASK_GUARDIAN:], [END_CALL], etc.).
   */
  voiceCallControlPrompt?: string;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class RunOrchestrator {
  private pending = new Map<string, PendingRunState>();
  private deps: RunOrchestratorDeps;

  constructor(deps: RunOrchestratorDeps) {
    this.deps = deps;

    // On startup, mark any runs left in non-terminal states as failed.
    // These are orphans from a previous daemon process that was interrupted.
    const recovered = runsStore.failOrphanedRuns();
    if (recovered > 0) {
      log.info({ count: recovered }, 'Recovered orphaned runs from previous session');
    }
  }

  /**
   * Start a new run: persist the user message, create a run record,
   * and fire the agent loop in the background.
   *
   * Returns a RunHandle containing the Run record and an abort() function
   * that can cancel the in-flight agent loop (e.g. for voice barge-in).
   */
  async startRun(
    conversationId: string,
    content: string,
    attachmentIds?: string[],
    options?: RunStartOptions,
  ): Promise<RunHandle> {
    // Block inbound content that contains secrets — mirrors the IPC check in sessions.ts
    const ingressCheck = checkIngressForSecrets(content);
    if (ingressCheck.blocked) {
      throw new IngressBlockedError(ingressCheck.userNotice!, ingressCheck.detectedTypes);
    }

    // Build transport metadata when channel context is available so the
    // session receives the same hints/uxBrief as the non-orchestrator path.
    const transport = options?.sourceChannel
      ? {
          channelId: options.sourceChannel,
          hints: options.hints,
          uxBrief: options.uxBrief,
        }
      : undefined;

    const session = await this.deps.getOrCreateSession(conversationId, transport);

    if (session.isProcessing()) {
      // Voice barge-in can race with turn teardown. Wait briefly for the
      // previous run to finish aborting before giving up.
      const maxWaitMs = 3000;
      const pollIntervalMs = 50;
      let waited = 0;
      while (session.isProcessing() && waited < maxWaitMs) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        waited += pollIntervalMs;
      }
      if (session.isProcessing()) {
        throw new Error('Session is already processing a message');
      }
    }

    // Determine the correct strictSideEffects value for this run:
    // - explicit true/false from the caller → use that value
    // - undefined → re-derive from the conversation's thread type so a
    //   prior run's forceStrictSideEffects=true doesn't stick on the
    //   cached session (private threads → true, standard → false)
    const strictSideEffects = options?.forceStrictSideEffects
      ?? this.deps.deriveDefaultStrictSideEffects(conversationId);
    session.memoryPolicy = {
      ...session.memoryPolicy,
      strictSideEffects,
    };
    session.setAssistantId(options?.assistantId ?? 'self');
    session.setGuardianContext(options?.guardianContext ?? null);
    session.setCommandIntent(options?.commandIntent ?? null);
    session.setTurnChannelContext(options?.turnChannelContext ?? {
      userMessageChannel: parseChannelId(options?.sourceChannel) ?? 'vellum',
      assistantMessageChannel: parseChannelId(options?.sourceChannel) ?? 'vellum',
    });
    const resolvedInterface = parseInterfaceId(options?.sourceInterface)
      ?? parseInterfaceId(options?.sourceChannel) ?? ('vellum' as InterfaceId);
    session.setTurnInterfaceContext({
      userMessageInterface: resolvedInterface,
      assistantMessageInterface: resolvedInterface,
    });

    const attachments = attachmentIds
      ? this.deps.resolveAttachments(attachmentIds)
      : [];

    const requestId = crypto.randomUUID();
    const messageId = session.persistUserMessage(content, attachments, requestId);
    const run = runsStore.createRun(conversationId, messageId);

    // Set channel capabilities based on the originating channel so capabilities
    // (e.g. attachment scope) match the actual transport rather than always
    // defaulting to 'vellum'.
    session.setChannelCapabilities(resolveChannelCapabilities(options?.sourceChannel ?? 'vellum'));
    session.setVoiceCallControlPrompt(options?.voiceCallControlPrompt ?? null);

    // Serialized publish chain so hub subscribers observe events in order.
    let hubChain: Promise<void> = Promise.resolve();
    const publishToHub = (msg: ServerMessage): void => {
      const msgRecord = msg as unknown as Record<string, unknown>;
      const msgSessionId =
        'sessionId' in msg && typeof msgRecord.sessionId === 'string'
          ? (msgRecord.sessionId as string)
          : undefined;
      const resolvedSessionId = msgSessionId ?? conversationId;
      const event = buildAssistantEvent('self', msg, resolvedSessionId);
      hubChain = (async () => {
        await hubChain;
        try {
          await assistantEventHub.publish(event);
        } catch (err) {
          log.warn({ err }, 'assistant-events hub subscriber threw during HTTP run');
        }
      })();
    };


    // Hook into session to intercept confirmation_request and secret_request events.
    // When the prompter sends one of these, we record it in the run store so
    // the client can poll and submit a decision/secret via the respective endpoint.
    // Do NOT set hasNoClient — run sessions have a client (the HTTP caller).
    const autoDeny = options?.voiceAutoDenyConfirmations === true;
    const autoAllow = !autoDeny && options?.voiceAutoAllowConfirmations === true;
    const autoResolveSecrets = options?.voiceAutoResolveSecrets === true;
    let lastError: string | null = null;
    session.updateClient((msg: ServerMessage) => {
      if (msg.type === 'confirmation_request') {
        if (autoDeny) {
          // Voice path with strict side effects: immediately deny the
          // confirmation request so the agent loop resumes without
          // waiting for the full permission timeout (300s). The voice
          // transport has no interactive approval UI, so polling would
          // just stall. Security is preserved — the tool call is denied.
          log.info(
            { runId: run.id, toolName: msg.toolName },
            'Auto-denying confirmation request for voice turn (forceStrictSideEffects)',
          );
          session.handleConfirmationResponse(
            msg.requestId,
            'deny',
            undefined,
            undefined,
            `Permission denied for "${msg.toolName}": this voice call does not have interactive approval capabilities. Side-effect tools are not available for non-guardian voice callers. In your next assistant reply, explain briefly that this action requires guardian-level access and cannot be performed during this call.`,
          );
          // Still publish to hub for observability, but skip run-store
          // bookkeeping since the confirmation is already resolved.
          publishToHub(msg);
          return;
        }
        if (autoAllow) {
          // Verified guardian voice turn: auto-approve so voice has the same
          // permission capabilities as guardian chat despite lacking an
          // interactive confirmation UI.
          log.info(
            { runId: run.id, toolName: msg.toolName },
            'Auto-approving confirmation request for guardian voice turn',
          );
          session.handleConfirmationResponse(
            msg.requestId,
            'allow',
            undefined,
            undefined,
            `Permission approved for "${msg.toolName}": this is a verified guardian voice call.`,
          );
          // Publish for observability, but skip run-store pending state since
          // the request is already resolved.
          publishToHub(msg);
          return;
        }

        runsStore.setRunConfirmation(run.id, {
          toolName: msg.toolName,
          toolUseId: msg.requestId,
          input: msg.input,
          riskLevel: msg.riskLevel,
          executionTarget: msg.executionTarget,
          allowlistOptions: msg.allowlistOptions,
          scopeOptions: msg.scopeOptions,
          persistentDecisionsAllowed: msg.persistentDecisionsAllowed,
        });
        this.pending.set(run.id, {
          prompterRequestId: msg.requestId,
          session,
        });
      } else if (msg.type === 'secret_request') {
        if (autoResolveSecrets) {
          // Voice has no secret-entry UI, so resolve immediately to avoid
          // waiting for the full secret prompt timeout.
          log.info(
            { runId: run.id, service: msg.service, field: msg.field },
            'Auto-resolving secret request for voice turn (no secret-entry UI)',
          );
          session.handleSecretResponse(msg.requestId, undefined, 'store');
          publishToHub(msg);
          return;
        }

        runsStore.setRunSecret(run.id, {
          requestId: msg.requestId,
          service: msg.service,
          field: msg.field,
          label: msg.label,
          description: msg.description,
          placeholder: msg.placeholder,
          purpose: msg.purpose,
          allowOneTimeSend: msg.allowOneTimeSend,
        });
        this.pending.set(run.id, {
          prompterRequestId: msg.requestId,
          session,
        });
      }
      // Mirror every outbound message to the assistant-events hub so SSE
      // subscribers receive the same payload parity as IPC clients.
      publishToHub(msg);
    });

    // Fire-and-forget the agent loop
    const cleanup = () => {
      this.pending.delete(run.id);
      // Reset channel capabilities so a subsequent IPC/desktop session on the
      // same conversation is not incorrectly treated as an HTTP-API client.
      session.setChannelCapabilities(null);
      session.setGuardianContext(null);
      session.setCommandIntent(null);
      session.setAssistantId('self');
      session.setVoiceCallControlPrompt(null);
      // Reset turn interface context so a subsequent IPC/desktop session on the
      // same conversation is not incorrectly treated as an HTTP-API interface.
      session.setTurnInterfaceContext({
        userMessageInterface: 'vellum' as InterfaceId,
        assistantMessageInterface: 'vellum' as InterfaceId,
      });
      // Reset the session's client callback to a no-op so the stale
      // closure doesn't intercept events from future runs on the same session.
      // Set hasNoClient=true here since the run is done and no HTTP caller
      // is actively listening — truly no client at this point.
      session.updateClient(() => {}, true);
    };

    const eventSink = options?.eventSink;

    void (async () => {
      try {
        await session.runAgentLoop(content, messageId, (msg: ServerMessage) => {
          if (msg.type === 'error') {
            lastError = msg.message;
          } else if (msg.type === 'session_error') {
            lastError = msg.userMessage;
          }
          // Mirror agent-loop events (assistant_text_delta, message_complete,
          // tool_use_start, tool_result, etc.) to the hub. These travel through
          // the onEvent path, distinct from the updateClient path used by the
          // prompter (confirmation_request). Both paths must publish so SSE
          // consumers receive the full response stream.
          publishToHub(msg);

          // Forward voice-relevant events to the real-time event sink when
          // provided. This runs in addition to (not instead of) the hub
          // publication above so both paths remain active.
          if (eventSink) {
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
          }
        });
        if (lastError) {
          log.error({ runId: run.id, error: lastError }, 'Run failed (error event from agent loop)');
          runsStore.failRun(run.id, lastError);
        } else {
          runsStore.completeRun(run.id);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, runId: run.id }, 'Run failed');
        runsStore.failRun(run.id, message);
        // Notify the voice event sink so the caller's turnComplete
        // promise settles instead of hanging on unhandled exceptions.
        if (eventSink) {
          eventSink.onError(message);
        }
      } finally {
        cleanup();
      }
    })();

    return {
      run,
      // Scope the abort to this specific run by capturing the requestId.
      // If the session has moved on to a new turn (different currentRequestId),
      // this abort is stale and becomes a no-op — preventing voice barge-in
      // from cancelling unrelated turns.
      abort: () => {
        if (session.currentRequestId === requestId) {
          session.abort();
        }
      },
    };
  }

  /** Read current run state from the store. */
  getRun(runId: string): Run | null {
    return runsStore.getRun(runId);
  }

  /**
   * Submit a permission decision for a pending confirmation.
   *
   * Returns:
   * - `'applied'`         – decision was applied or already handled (idempotent)
   * - `'run_not_found'`   – no run exists with the given ID
   * - `'no_pending_decision'` – run exists but is not awaiting a confirmation
   */
  submitDecision(
    runId: string,
    decision: UserDecision,
    decisionContext?: string,
  ): 'applied' | 'run_not_found' | 'no_pending_decision' {
    const pendingState = this.pending.get(runId);
    if (pendingState) {
      runsStore.clearRunConfirmation(runId);
      pendingState.session.handleConfirmationResponse(
        pendingState.prompterRequestId,
        decision,
        undefined,
        undefined,
        decisionContext,
      );
      this.pending.delete(runId);
      return 'applied';
    }

    // No in-memory pending state — check if the run exists.
    const run = runsStore.getRun(runId);
    if (!run) return 'run_not_found';

    // If the run is still needs_confirmation but there's no in-memory
    // state, the prompter already timed out and auto-denied. Fail the
    // run rather than clearing to 'running', since no agent loop exists
    // to complete it.
    if (run.status === 'needs_confirmation') {
      runsStore.failRun(runId, 'Prompter timed out (no active handler)');
      return 'applied';
    }

    // Terminal states (completed/failed) mean the decision was already
    // handled (double-submit). Treat as idempotent success.
    if (run.status === 'completed' || run.status === 'failed') {
      return 'applied';
    }

    // Run is in 'running' state with no pending confirmation — the
    // agent loop hasn't reached a confirmation point yet. Reject so
    // the client doesn't mistakenly treat the decision as accepted.
    return 'no_pending_decision';
  }

  /**
   * Submit a secret value for a pending secret request.
   *
   * Returns:
   * - `'applied'`           – secret was forwarded to the session
   * - `'run_not_found'`     – no run exists with the given ID
   * - `'no_pending_secret'` – run exists but is not awaiting a secret
   */
  submitSecret(
    runId: string,
    value?: string,
    delivery?: 'store' | 'transient_send',
  ): 'applied' | 'run_not_found' | 'no_pending_secret' {
    const pendingState = this.pending.get(runId);
    if (pendingState) {
      runsStore.clearRunSecret(runId);
      pendingState.session.handleSecretResponse(
        pendingState.prompterRequestId,
        value,
        delivery,
      );
      this.pending.delete(runId);
      return 'applied';
    }

    const run = runsStore.getRun(runId);
    if (!run) return 'run_not_found';

    if (run.status === 'needs_secret') {
      runsStore.failRun(runId, 'Secret prompter timed out (no active handler)');
      return 'applied';
    }

    if (run.status === 'completed' || run.status === 'failed') {
      return 'applied';
    }

    return 'no_pending_secret';
  }
}

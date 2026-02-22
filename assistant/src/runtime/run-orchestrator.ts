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

import * as runsStore from '../memory/runs-store.js';
import type { Run } from '../memory/runs-store.js';
import type { Session } from '../daemon/session.js';
import type { ServerMessage } from '../daemon/ipc-protocol.js';
import { resolveChannelCapabilities } from '../daemon/session-runtime-assembly.js';
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

interface PendingRunState {
  prompterRequestId: string;
  session: Session;
}

export interface RunOrchestratorDeps {
  getOrCreateSession: (conversationId: string) => Promise<Session>;
  resolveAttachments: (attachmentIds: string[]) => Array<{
    id: string;
    filename: string;
    mimeType: string;
    data: string;
  }>;
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
   * default 'http-api'.
   */
  sourceChannel?: string;
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
   */
  async startRun(
    conversationId: string,
    content: string,
    attachmentIds?: string[],
    options?: RunStartOptions,
  ): Promise<Run> {
    // Block inbound content that contains secrets — mirrors the IPC check in sessions.ts
    const ingressCheck = checkIngressForSecrets(content);
    if (ingressCheck.blocked) {
      throw new IngressBlockedError(ingressCheck.userNotice!, ingressCheck.detectedTypes);
    }

    const session = await this.deps.getOrCreateSession(conversationId);

    if (session.isProcessing()) {
      throw new Error('Session is already processing a message');
    }

    // Only override strictSideEffects when the caller explicitly requests it
    // (e.g. guardian-gated channels forcing strict mode on for non-guardian
    // actors). When not provided, preserve the session's existing memory
    // policy — this avoids clobbering conversation-level defaults such as
    // private-thread policies derived in server.ts.
    if (options?.forceStrictSideEffects !== undefined) {
      session.memoryPolicy = {
        ...session.memoryPolicy,
        strictSideEffects: options.forceStrictSideEffects,
      };
    }

    const attachments = attachmentIds
      ? this.deps.resolveAttachments(attachmentIds)
      : [];

    const requestId = crypto.randomUUID();
    const messageId = session.persistUserMessage(content, attachments, requestId);
    const run = runsStore.createRun(conversationId, messageId);

    // Set channel capabilities based on the originating channel so capabilities
    // (e.g. attachment scope) match the actual transport rather than always
    // defaulting to 'http-api'.
    session.setChannelCapabilities(resolveChannelCapabilities(options?.sourceChannel ?? 'http-api'));

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
      hubChain = hubChain
        .then(() => assistantEventHub.publish(event))
        .catch((err: unknown) => {
          log.warn({ err }, 'assistant-events hub subscriber threw during HTTP run');
        });
    };


    // Hook into session to intercept confirmation_request and secret_request events.
    // When the prompter sends one of these, we record it in the run store so
    // the client can poll and submit a decision/secret via the respective endpoint.
    // Do NOT set hasNoClient — run sessions have a client (the HTTP caller).
    let lastError: string | null = null;
    session.updateClient((msg: ServerMessage) => {
      if (msg.type === 'confirmation_request') {
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
      // Reset the session's client callback to a no-op so the stale
      // closure doesn't intercept events from future runs on the same session.
      // Set hasNoClient=true here since the run is done and no HTTP caller
      // is actively listening — truly no client at this point.
      session.updateClient(() => {}, true);
    };

    session.runAgentLoop(content, messageId, (msg: ServerMessage) => {
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
    }).then(() => {
      if (lastError) {
        log.error({ runId: run.id, error: lastError }, 'Run failed (error event from agent loop)');
        runsStore.failRun(run.id, lastError);
      } else {
        runsStore.completeRun(run.id);
      }
      cleanup();
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, runId: run.id }, 'Run failed');
      runsStore.failRun(run.id, message);
      cleanup();
    });

    return run;
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
  submitDecision(runId: string, decision: UserDecision): 'applied' | 'run_not_found' | 'no_pending_decision' {
    const pendingState = this.pending.get(runId);
    if (pendingState) {
      runsStore.clearRunConfirmation(runId);
      pendingState.session.handleConfirmationResponse(
        pendingState.prompterRequestId,
        decision,
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

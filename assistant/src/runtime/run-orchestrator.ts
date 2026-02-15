/**
 * Orchestrates run lifecycle for the HTTP runtime API.
 *
 * A "run" wraps a single agent-loop execution, tracking its state through:
 *   running → needs_confirmation → running → completed | failed
 *
 * When a tool needs permission, the orchestrator intercepts the
 * confirmation_request from the session's prompter and records it in
 * the run store.  The web UI can then poll the run status and submit
 * a decision via the /decision endpoint.
 */

import * as runsStore from '../memory/runs-store.js';
import type { Run } from '../memory/runs-store.js';
import type { Session } from '../daemon/session.js';
import type { ServerMessage } from '../daemon/ipc-protocol.js';
import type { UserDecision } from '../permissions/types.js';
import { getLogger } from '../util/logger.js';

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
  resolveAttachments: (assistantId: string, attachmentIds: string[]) => Array<{
    id: string;
    filename: string;
    mimeType: string;
    data: string;
  }>;
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
    assistantId: string,
    conversationId: string,
    content: string,
    attachmentIds?: string[],
  ): Promise<Run> {
    const session = await this.deps.getOrCreateSession(conversationId);

    if (session.isProcessing()) {
      throw new Error('Session is already processing a message');
    }

    const attachments = attachmentIds
      ? this.deps.resolveAttachments(assistantId, attachmentIds)
      : [];

    const requestId = crypto.randomUUID();
    const messageId = session.persistUserMessage(content, attachments, requestId);
    const run = runsStore.createRun(assistantId, conversationId, messageId);

    // Set the assistant ID so attachments are scoped correctly.
    session.setAssistantId(assistantId);

    // Hook into session to intercept confirmation_request events.
    // When the prompter sends a confirmation_request, we record it in the
    // run store so the web UI can poll and submit a decision.
    // Do NOT set hasNoClient — run sessions have a client (the HTTP caller)
    // and confirmations are handled via the /runs/:id/decision endpoint.
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
        });
        this.pending.set(run.id, {
          prompterRequestId: msg.requestId,
          session,
        });
      }
    });

    // Fire-and-forget the agent loop
    const cleanup = () => {
      this.pending.delete(run.id);
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
}

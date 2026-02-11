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

    // Hook into session to intercept confirmation_request events.
    // When the prompter sends one, we record it in the run store so
    // the web UI can poll and submit a decision.
    session.updateClient((msg: ServerMessage) => {
      if (msg.type === 'confirmation_request') {
        runsStore.setRunConfirmation(run.id, {
          toolName: msg.toolName,
          toolUseId: msg.requestId,
          input: msg.input,
          riskLevel: msg.riskLevel,
        });
        this.pending.set(run.id, {
          prompterRequestId: msg.requestId,
          session,
        });
      }
    });

    // Fire-and-forget the agent loop
    session.runAgentLoop(content, messageId, () => {}).then(() => {
      runsStore.completeRun(run.id);
      this.pending.delete(run.id);
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, runId: run.id }, 'Run failed');
      runsStore.failRun(run.id, message);
      this.pending.delete(run.id);
    });

    return run;
  }

  /** Read current run state from the store. */
  getRun(runId: string): Run | null {
    return runsStore.getRun(runId);
  }

  /**
   * Submit a permission decision for a pending confirmation.
   * Returns true if the decision was applied or was already handled
   * (idempotent). Returns false only if the run doesn't exist.
   */
  submitDecision(runId: string, decision: UserDecision): boolean {
    const pendingState = this.pending.get(runId);
    if (pendingState) {
      runsStore.clearRunConfirmation(runId);
      pendingState.session.handleConfirmationResponse(
        pendingState.prompterRequestId,
        decision,
      );
      this.pending.delete(runId);
      return true;
    }

    // No in-memory pending state — check if the run exists.
    // If it's in a terminal or running state, the decision was already
    // handled (double-submit) or the prompter timed out. Either way,
    // treat as idempotent success.
    const run = runsStore.getRun(runId);
    if (!run) return false;

    // If the run is still needs_confirmation but there's no in-memory
    // state, the prompter already timed out and auto-denied. Clear the
    // stale confirmation to keep the stored state consistent.
    if (run.status === 'needs_confirmation') {
      runsStore.clearRunConfirmation(runId);
    }

    return true;
  }
}

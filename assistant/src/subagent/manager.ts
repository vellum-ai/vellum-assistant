/**
 * SubagentManager — owns the lifecycle of all subagent sessions.
 *
 * Responsibilities:
 *   - spawn / abort / dispose subagent sessions
 *   - enforce concurrency and depth limits
 *   - route events from child sessions through parent's socket
 *   - inject completion summaries back into parent context
 */

import { v4 as uuid } from 'uuid';
import { Session, type SessionMemoryPolicy } from '../daemon/session.js';
import { createConversation } from '../memory/conversation-store.js';
import { getConfig } from '../config/loader.js';
import { getFailoverProvider } from '../providers/registry.js';
import { RateLimitProvider } from '../providers/ratelimit.js';
import { getSandboxWorkingDir } from '../util/platform.js';
import { getLogger } from '../util/logger.js';
import type { ServerMessage } from '../daemon/ipc-contract.js';
import {
  type SubagentConfig,
  type SubagentState,
  type SubagentStatus,
  SUBAGENT_LIMITS,
  TERMINAL_STATUSES,
} from './types.js';

const log = getLogger('subagent-manager');

// ── Default subagent system prompt ──────────────────────────────────────

function buildSubagentSystemPrompt(config: SubagentConfig): string {
  const sections: string[] = [
    'You are a focused subagent working on a specific task delegated by a parent assistant.',
    'Complete the task thoroughly and concisely.',
    '',
    `## Your Task`,
    config.objective,
  ];
  if (config.context) {
    sections.push('', '## Context from Parent', config.context);
  }
  return sections.join('\n');
}

// ── Manager ─────────────────────────────────────────────────────────────

interface ManagedSubagent {
  session: Session;
  state: SubagentState;
}

export type ParentNotifyCallback = (
  parentSessionId: string,
  message: string,
  sendToClient: (msg: ServerMessage) => void,
) => void;

export class SubagentManager {
  /** subagentId → ManagedSubagent */
  private subagents = new Map<string, ManagedSubagent>();
  /** parentSessionId → Set<subagentId> */
  private parentToChildren = new Map<string, Set<string>>();

  /**
   * Optional callback to inject a completion/failure message into the parent
   * session's conversation so the LLM can automatically inform the user.
   * Wired by DaemonServer at startup.
   */
  onSubagentFinished?: ParentNotifyCallback;

  /**
   * Shared rate-limit timestamps array from the daemon server.
   * Set by DaemonServer at startup so subagents share the global rate limit.
   */
  sharedRequestTimestamps: number[] = [];

  // ── Spawn ───────────────────────────────────────────────────────────

  /**
   * Spawn a new subagent.  Returns the subagent ID immediately.
   * The subagent's agent loop is started asynchronously (fire-and-forget).
   */
  async spawn(
    config: Omit<SubagentConfig, 'id'>,
    parentSendToClient: (msg: ServerMessage) => void,
  ): Promise<string> {
    // ── Limit checks ────────────────────────────────────────────────

    // Depth check: prevent subagents from spawning nested subagents.
    const isParentASubagent = [...this.subagents.values()].some(
      (s) => s.state.conversationId === config.parentSessionId,
    );
    if (isParentASubagent) {
      throw new Error(
        `Cannot spawn subagent: parent is itself a subagent (max depth ${SUBAGENT_LIMITS.maxDepth}).`,
      );
    }

    // ── Create conversation ─────────────────────────────────────────
    const subagentId = uuid();
    const conversation = createConversation({
      title: `Subagent: ${config.label}`,
      threadType: 'background',
    });

    // ── Build session dependencies ──────────────────────────────────
    const appConfig = getConfig();
    let provider = getFailoverProvider(appConfig.provider, appConfig.providerOrder);
    const { rateLimit } = appConfig;
    if (rateLimit.maxRequestsPerMinute > 0 || rateLimit.maxTokensPerSession > 0) {
      provider = new RateLimitProvider(provider, rateLimit, this.sharedRequestTimestamps);
    }

    const systemPrompt = config.systemPromptOverride ?? buildSubagentSystemPrompt({ ...config, id: subagentId });
    const maxTokens = appConfig.maxTokens;
    const workingDir = getSandboxWorkingDir();

    const memoryPolicy: SessionMemoryPolicy = {
      scopeId: `subagent:${subagentId}`,
      includeDefaultFallback: true,
      strictSideEffects: false,
    };

    // Wrap sendToClient to envelope all events with the subagent ID.
    const wrappedSendToClient = (msg: ServerMessage): void => {
      // Forward confirmation requests and other interactive messages as-is
      // so the client can render them in the subagent panel.
      parentSendToClient({
        type: 'subagent_event',
        subagentId,
        event: msg,
      } as ServerMessage);
    };

    const session = new Session(
      conversation.id,
      provider,
      systemPrompt,
      maxTokens,
      wrappedSendToClient,
      workingDir,
      undefined, // no broadcastToAllClients for subagents
      memoryPolicy,
    );

    // Mark session as having no direct IPC client — it routes through parent.
    // This ensures interactive prompts (host attachment reads) fail fast.
    session.updateClient(wrappedSendToClient, true);

    // ── Initialise state ────────────────────────────────────────────
    const now = Date.now();
    const state: SubagentState = {
      config: { ...config, id: subagentId },
      status: 'pending',
      conversationId: conversation.id,
      createdAt: now,
      usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    };

    const managed: ManagedSubagent = { session, state };
    this.subagents.set(subagentId, managed);

    // Track parent → child relationship.
    if (!this.parentToChildren.has(config.parentSessionId)) {
      this.parentToChildren.set(config.parentSessionId, new Set());
    }
    this.parentToChildren.get(config.parentSessionId)!.add(subagentId);

    // Notify client that a subagent was spawned.
    parentSendToClient({
      type: 'subagent_spawned',
      subagentId,
      parentSessionId: config.parentSessionId,
      label: config.label,
      objective: config.objective,
    } as ServerMessage);

    log.info(
      { subagentId, parentSessionId: config.parentSessionId, label: config.label },
      'Subagent spawned',
    );

    // ── Kick off the agent loop (fire-and-forget) ───────────────────
    this.runSubagent(subagentId, config.objective, parentSendToClient).catch((err) => {
      log.error({ subagentId, err }, 'Subagent run failed unexpectedly');
    });

    return subagentId;
  }

  // ── Internal: run the subagent ────────────────────────────────────────

  private async runSubagent(
    subagentId: string,
    objective: string,
    parentSendToClient: (msg: ServerMessage) => void,
  ): Promise<void> {
    const managed = this.subagents.get(subagentId);
    if (!managed) return;

    this.setStatus(subagentId, 'running', parentSendToClient);
    managed.state.startedAt = Date.now();

    const onEvent = managed.session.sendToClient;

    try {
      // Load any existing history (should be empty for a new conversation).
      await managed.session.loadFromDb();

      // Send the objective as the first user message and process it.
      const messageId = managed.session.persistUserMessage(objective, []);
      await managed.session.runAgentLoop(objective, messageId, onEvent);

      // Agent loop completed successfully.
      // Only update state + notify if still non-terminal (guards against abort race).
      if (!TERMINAL_STATUSES.has(managed.state.status)) {
        const summary = this.extractSummary(managed);
        managed.state.summary = summary;
        managed.state.completedAt = Date.now();
        this.setStatus(subagentId, 'completed', parentSendToClient, summary);

        log.info({ subagentId, summary: summary.slice(0, 200) }, 'Subagent completed');

        // Notify the parent session so the LLM can inform the user.
        this.notifyParent(managed, 'completed', parentSendToClient);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      managed.state.error = errorMsg;
      managed.state.completedAt = Date.now();

      // Only update status if not already terminal (e.g. aborted).
      if (!TERMINAL_STATUSES.has(managed.state.status)) {
        this.setStatus(subagentId, 'failed', parentSendToClient, undefined, errorMsg);
        this.notifyParent(managed, 'failed', parentSendToClient);
      }

      log.error({ subagentId, err }, 'Subagent failed');
    }
  }

  // ── Abort ─────────────────────────────────────────────────────────────

  abort(
    subagentId: string,
    parentSendToClient?: (msg: ServerMessage) => void,
    callerSessionId?: string,
  ): boolean {
    const managed = this.subagents.get(subagentId);
    if (!managed) return false;
    if (TERMINAL_STATUSES.has(managed.state.status)) return false;
    // If a caller session is specified, verify ownership.
    if (callerSessionId && managed.state.config.parentSessionId !== callerSessionId) {
      log.warn({ subagentId, callerSessionId, parentSessionId: managed.state.config.parentSessionId },
        'Abort rejected: caller does not own this subagent');
      return false;
    }

    managed.session.abort();
    managed.state.completedAt = Date.now();
    if (parentSendToClient) {
      this.setStatus(subagentId, 'aborted', parentSendToClient);
      // Notify parent about the abort.
      if (this.onSubagentFinished) {
        const label = managed.state.config.label;
        try {
          this.onSubagentFinished(
            managed.state.config.parentSessionId,
            `[Subagent "${label}" was aborted]`,
            parentSendToClient,
          );
        } catch (err) {
          log.error({ subagentId, err }, 'Failed to notify parent about abort');
        }
      }
    } else {
      managed.state.status = 'aborted';
    }

    log.info({ subagentId }, 'Subagent aborted');
    return true;
  }

  /**
   * Abort all subagents belonging to a parent session.
   * Called when the parent session is aborted or evicted.
   */
  abortAllForParent(
    parentSessionId: string,
    parentSendToClient?: (msg: ServerMessage) => void,
  ): number {
    const children = this.parentToChildren.get(parentSessionId);
    if (!children) return 0;

    let count = 0;
    for (const childId of children) {
      if (this.abort(childId, parentSendToClient)) {
        count++;
      }
    }
    return count;
  }

  // ── Send message to subagent ──────────────────────────────────────────

  sendMessage(subagentId: string, content: string): boolean {
    const managed = this.subagents.get(subagentId);
    if (!managed) return false;
    if (TERMINAL_STATUSES.has(managed.state.status)) return false;

    const onEvent = managed.session.sendToClient;
    const requestId = uuid();

    // If the session is busy, queue the message; otherwise process immediately.
    const result = managed.session.enqueueMessage(content, [], onEvent, requestId);
    if (result.rejected) return false;
    if (!result.queued) {
      // Session is idle — send directly.  Fire-and-forget so we don't block.
      const messageId = managed.session.persistUserMessage(content, []);
      managed.session.runAgentLoop(content, messageId, onEvent).catch((err) => {
        log.error({ subagentId, err }, 'Subagent message processing failed');
      });
    }
    return true;
  }

  // ── Queries ───────────────────────────────────────────────────────────

  getState(subagentId: string): SubagentState | undefined {
    return this.subagents.get(subagentId)?.state;
  }

  getChildrenOf(parentSessionId: string): SubagentState[] {
    const children = this.parentToChildren.get(parentSessionId);
    if (!children) return [];
    return [...children]
      .map((id) => this.subagents.get(id)?.state)
      .filter((s): s is SubagentState => s !== undefined);
  }

  /** Total number of active (non-terminal) subagents. */
  get activeCount(): number {
    return [...this.subagents.values()].filter(
      (s) => !TERMINAL_STATUSES.has(s.state.status),
    ).length;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  /**
   * Dispose a subagent and remove it from tracking.
   * Should be called after the subagent reaches a terminal state
   * and its data is no longer needed.
   */
  dispose(subagentId: string): void {
    const managed = this.subagents.get(subagentId);
    if (!managed) return;

    if (!TERMINAL_STATUSES.has(managed.state.status)) {
      managed.session.abort();
    }
    managed.session.dispose();
    this.subagents.delete(subagentId);

    // Remove from parent tracking.
    const parentId = managed.state.config.parentSessionId;
    const siblings = this.parentToChildren.get(parentId);
    if (siblings) {
      siblings.delete(subagentId);
      if (siblings.size === 0) {
        this.parentToChildren.delete(parentId);
      }
    }
  }

  /** Dispose all subagents. Called on daemon shutdown. */
  disposeAll(): void {
    for (const id of [...this.subagents.keys()]) {
      this.dispose(id);
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private setStatus(
    subagentId: string,
    status: SubagentStatus,
    parentSendToClient: (msg: ServerMessage) => void,
    summary?: string,
    error?: string,
  ): void {
    const managed = this.subagents.get(subagentId);
    if (!managed) return;

    // Idempotent terminal state guard.
    if (TERMINAL_STATUSES.has(managed.state.status) && managed.state.status !== status) {
      return;
    }

    managed.state.status = status;
    if (summary !== undefined) managed.state.summary = summary;
    if (error !== undefined) managed.state.error = error;

    parentSendToClient({
      type: 'subagent_status_changed',
      subagentId,
      status,
      summary,
      error,
      usage: managed.state.usage,
    } as ServerMessage);
  }

  private extractSummary(managed: ManagedSubagent): string {
    // Extract a brief summary from the last assistant message (first paragraph or ~500 chars).
    const { messages } = managed.session;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant') continue;
      const content = msg.content;
      if (Array.isArray(content)) {
        const textBlocks = content
          .filter((b) => b.type === 'text' && 'text' in b)
          .map((b) => (b as { type: 'text'; text: string }).text);
        if (textBlocks.length > 0) {
          const fullText = textBlocks.join('\n');
          // Take the first paragraph or first 500 chars, whichever is shorter.
          const firstParagraph = fullText.split('\n\n')[0] ?? fullText;
          if (firstParagraph.length <= 500) return firstParagraph;
          return firstParagraph.slice(0, 500) + '…';
        }
      }
    }
    return '(No summary available)';
  }

  /**
   * Inject a completion/failure notification into the parent session
   * so the LLM automatically informs the user.
   */
  private notifyParent(
    managed: ManagedSubagent,
    outcome: 'completed' | 'failed',
    parentSendToClient: (msg: ServerMessage) => void,
  ): void {
    if (!this.onSubagentFinished) return;

    const { config } = managed.state;
    let message: string;

    if (outcome === 'completed') {
      const summary = managed.state.summary ?? '(No summary available)';
      message =
        `[Subagent "${config.label}" completed]\n\n` +
        `Summary: ${summary}\n\n` +
        `Use subagent_read with subagent_id "${config.id}" to retrieve the full output.`;
    } else {
      const error = managed.state.error ?? 'Unknown error';
      message =
        `[Subagent "${config.label}" failed]\n\n` +
        `Error: ${error}`;
    }

    try {
      this.onSubagentFinished(config.parentSessionId, message, parentSendToClient);
    } catch (err) {
      log.error({ subagentId: config.id, err }, 'Failed to notify parent session');
    }
  }
}

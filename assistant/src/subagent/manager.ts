/**
 * SubagentManager — owns the lifecycle of all subagent sessions.
 *
 * Responsibilities:
 *   - spawn / abort / dispose subagent sessions
 *   - enforce concurrency and depth limits
 *   - route events from child sessions through parent's socket
 *   - inject completion summaries back into parent context
 */

import { v4 as uuid } from "uuid";

import { getConfig } from "../config/loader.js";
import {
  Conversation,
  type ConversationMemoryPolicy,
} from "../daemon/conversation.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { bootstrapConversation } from "../memory/conversation-bootstrap.js";
import { RateLimitProvider } from "../providers/ratelimit.js";
import { getFailoverProvider } from "../providers/registry.js";
import { getLogger } from "../util/logger.js";
import { getSandboxWorkingDir } from "../util/platform.js";
import {
  SUBAGENT_LIMITS,
  type SubagentConfig,
  type SubagentState,
  type SubagentStatus,
  TERMINAL_STATUSES,
} from "./types.js";

const log = getLogger("subagent-manager");

// ── Default subagent system prompt ──────────────────────────────────────

function buildSubagentSystemPrompt(config: SubagentConfig): string {
  const sections: string[] = [
    "You are a focused subagent working on a specific task delegated by a parent assistant.",
    "Complete the task thoroughly and concisely.",
    "",
    `## Your Task`,
    config.objective,
  ];
  if (config.context) {
    sections.push("", "## Context from Parent", config.context);
  }
  return sections.join("\n");
}

// ── Manager ─────────────────────────────────────────────────────────────

interface ManagedSubagent {
  conversation: Conversation;
  state: SubagentState;
  /** Mutable reference to the parent's current sendToClient. Updated on reconnect. */
  parentSendToClient: (msg: ServerMessage) => void;
}

export interface SubagentNotificationInfo {
  subagentId: string;
  label: string;
  status: "completed" | "failed" | "aborted";
  error?: string;
  conversationId?: string;
}

export type ParentNotifyCallback = (
  parentConversationId: string,
  message: string,
  sendToClient: (msg: ServerMessage) => void,
  notification: SubagentNotificationInfo,
) => void;

export class SubagentManager {
  /** subagentId → ManagedSubagent */
  private subagents = new Map<string, ManagedSubagent>();
  /** parentConversationId → Set<subagentId> */
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

  /**
   * Broadcast callback from the daemon server.
   * Set by DaemonServer at startup so subagent sessions can broadcast
   * to all connected clients (e.g. app_files_changed side-effects).
   */
  broadcastToAllClients?: (msg: ServerMessage) => void;

  // ── Spawn ───────────────────────────────────────────────────────────

  /**
   * Spawn a new subagent.  Returns the subagent ID immediately.
   * The subagent's agent loop is started asynchronously (fire-and-forget).
   */
  async spawn(
    config: Omit<SubagentConfig, "id">,
    parentSendToClient: (msg: ServerMessage) => void,
  ): Promise<string> {
    // ── Limit checks ────────────────────────────────────────────────

    // Depth check: prevent subagents from spawning nested subagents.
    const isParentASubagent = [...this.subagents.values()].some(
      (s) => s.state.conversationId === config.parentConversationId,
    );
    if (isParentASubagent) {
      throw new Error(
        `Cannot spawn subagent: parent is itself a subagent (max depth ${SUBAGENT_LIMITS.maxDepth}).`,
      );
    }

    // ── Create conversation ─────────────────────────────────────────
    const subagentId = uuid();
    const conversationRecord = bootstrapConversation({
      conversationType: "background",
      origin: "subagent",
      systemHint: `Subagent: ${config.label}`,
    });

    // ── Build conversation dependencies ─────────────────────────────
    const appConfig = getConfig();
    let provider = getFailoverProvider(
      appConfig.services.inference.provider,
      appConfig.providerOrder,
    );
    const { rateLimit } = appConfig;
    if (
      rateLimit.maxRequestsPerMinute > 0 ||
      rateLimit.maxTokensPerSession > 0
    ) {
      provider = new RateLimitProvider(
        provider,
        rateLimit,
        this.sharedRequestTimestamps,
      );
    }

    const systemPrompt =
      config.systemPromptOverride ??
      buildSubagentSystemPrompt({ ...config, id: subagentId });
    const maxTokens = appConfig.maxTokens;
    const workingDir = getSandboxWorkingDir();

    const memoryPolicy: ConversationMemoryPolicy = {
      scopeId: `subagent:${subagentId}`,
      includeDefaultFallback: true,
      strictSideEffects: false,
    };

    // ── Initialise state ────────────────────────────────────────────
    const now = Date.now();
    const state: SubagentState = {
      config: { ...config, id: subagentId },
      status: "pending",
      conversationId: conversationRecord.id,
      createdAt: now,
      usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    };

    // Store the managed subagent early so the wrapper can read the mutable
    // parentSendToClient reference — this ensures reconnects are picked up.
    const managed: ManagedSubagent = {
      // Placeholder — replaced with the real Conversation a few lines below, before
      // any code reads this field. Using null! avoids the `as unknown as` cast.
      conversation: null! as Conversation,
      state,
      parentSendToClient,
    };

    // Wrap sendToClient to envelope all events with the subagent ID.
    // Reads from managed.parentSendToClient so reconnects are picked up.
    const wrappedSendToClient = (msg: ServerMessage): void => {
      managed.parentSendToClient({
        type: "subagent_event",
        subagentId,
        event: msg,
      } as ServerMessage);
    };

    const conversation = new Conversation(
      conversationRecord.id,
      provider,
      systemPrompt,
      maxTokens,
      wrappedSendToClient,
      workingDir,
      this.broadcastToAllClients, // forward parent's broadcast so tool side-effects (e.g. app_files_changed) reach all clients
      memoryPolicy,
    );

    // Mark conversation as having no direct client — it routes through parent.
    // This ensures interactive prompts (host attachment reads) fail fast.
    conversation.updateClient(wrappedSendToClient, true);

    managed.conversation = conversation;
    this.subagents.set(subagentId, managed);

    // Track parent → child relationship.
    if (!this.parentToChildren.has(config.parentConversationId)) {
      this.parentToChildren.set(config.parentConversationId, new Set());
    }
    this.parentToChildren.get(config.parentConversationId)!.add(subagentId);

    // Notify client that a subagent was spawned.
    parentSendToClient({
      type: "subagent_spawned",
      subagentId,
      parentConversationId: config.parentConversationId,
      label: config.label,
      objective: config.objective,
    } as ServerMessage);

    log.info(
      {
        subagentId,
        parentConversationId: config.parentConversationId,
        label: config.label,
      },
      "Subagent spawned",
    );

    // ── Kick off the agent loop (fire-and-forget) ───────────────────
    this.runSubagent(subagentId, config.objective).catch((err) => {
      log.error({ subagentId, err }, "Subagent run failed unexpectedly");
    });

    return subagentId;
  }

  // ── Internal: run the subagent ────────────────────────────────────────

  private async runSubagent(
    subagentId: string,
    objective: string,
  ): Promise<void> {
    const managed = this.subagents.get(subagentId);
    if (!managed) return;

    // Read the current parent sender so reconnects are picked up.
    const getSender = () => managed.parentSendToClient;

    this.setStatus(subagentId, "running", getSender());
    managed.state.startedAt = Date.now();

    const onEvent = managed.conversation.sendToClient;

    try {
      // Send the objective as the first user message and process it.
      const messageId = await managed.conversation.persistUserMessage(
        objective,
        [],
      );
      await managed.conversation.runAgentLoop(objective, messageId, onEvent);

      // Agent loop completed successfully.
      // Copy usage stats from the session before sending status (which includes usage).
      managed.state.usage = { ...managed.conversation.usageStats };
      // Only update state + notify if still non-terminal (guards against abort race).
      if (!TERMINAL_STATUSES.has(managed.state.status)) {
        managed.state.completedAt = Date.now();
        this.setStatus(subagentId, "completed", getSender());

        log.info({ subagentId }, "Subagent completed");

        // Notify the parent session so the LLM can call subagent_read.
        this.notifyParent(managed, "completed", getSender());
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      managed.state.error = errorMsg;
      managed.state.completedAt = Date.now();
      managed.state.usage = { ...managed.conversation.usageStats };

      // Only update status if not already terminal (e.g. aborted).
      if (!TERMINAL_STATUSES.has(managed.state.status)) {
        this.setStatus(subagentId, "failed", getSender(), errorMsg);
        this.notifyParent(managed, "failed", getSender());
      }

      log.error({ subagentId, err }, "Subagent failed");
    }
  }

  // ── Abort ─────────────────────────────────────────────────────────────

  abort(
    subagentId: string,
    parentSendToClient?: (msg: ServerMessage) => void,
    callerConversationId?: string,
    options?: { suppressNotification?: boolean },
  ): boolean {
    const managed = this.subagents.get(subagentId);
    if (!managed) return false;
    if (TERMINAL_STATUSES.has(managed.state.status)) return false;
    // If a caller conversation is specified, verify ownership.
    if (
      callerConversationId &&
      managed.state.config.parentConversationId !== callerConversationId
    ) {
      log.warn(
        {
          subagentId,
          callerConversationId,
          parentConversationId: managed.state.config.parentConversationId,
        },
        "Abort rejected: caller does not own this subagent",
      );
      return false;
    }

    managed.conversation.abort();
    managed.state.completedAt = Date.now();
    if (parentSendToClient) {
      // Route the status update through the stored parent sender so the
      // owning session's UI chip updates, even when the abort comes from a
      // different socket (e.g. after conversation switching). Fall back to the
      // caller-provided sender if no stored sender exists.
      const statusSender = managed.parentSendToClient ?? parentSendToClient;
      this.setStatus(subagentId, "aborted", statusSender);
      // Notify parent that the subagent was explicitly aborted — tell it NOT to re-spawn.
      // Skip when the parent LLM itself called subagent_abort (it already has the tool result).
      if (this.onSubagentFinished && !options?.suppressNotification) {
        const label = managed.state.config.label;
        const message =
          `[Subagent "${label}" was explicitly aborted]\n\n` +
          `This subagent was cancelled on purpose. Do NOT re-spawn or retry it.`;
        try {
          // Use the managed subagent's stored parentSendToClient so the
          // notification routes to the parent session's socket, not the
          // aborting socket (which may be a different conversation after switching).
          this.onSubagentFinished(
            managed.state.config.parentConversationId,
            message,
            managed.parentSendToClient,
            {
              subagentId,
              label,
              status: "aborted",
              conversationId: managed.state.conversationId,
            },
          );
        } catch (err) {
          log.error({ subagentId, err }, "Failed to notify parent about abort");
        }
      }
    } else {
      managed.state.status = "aborted";
    }

    log.info({ subagentId }, "Subagent aborted");
    return true;
  }

  /**
   * Abort all subagents belonging to a parent session.
   * Called when the parent session is aborted or evicted.
   */
  abortAllForParent(
    parentConversationId: string,
    parentSendToClient?: (msg: ServerMessage) => void,
  ): number {
    const children = this.parentToChildren.get(parentConversationId);
    if (!children) return 0;

    let count = 0;
    for (const childId of children) {
      if (this.abort(childId, parentSendToClient)) {
        count++;
      }
    }

    // Dispose all children — the parent session is going away so nobody
    // will call subagent_read.  Use snapshot since dispose mutates the set.
    for (const childId of [...children]) {
      this.dispose(childId);
    }

    return count;
  }

  // ── Send message to subagent ──────────────────────────────────────────

  async sendMessage(
    subagentId: string,
    content: string,
  ): Promise<"sent" | "empty" | "not_found" | "terminal"> {
    const trimmed = content?.trim();
    if (!trimmed) return "empty";

    const managed = this.subagents.get(subagentId);
    if (!managed) return "not_found";
    if (TERMINAL_STATUSES.has(managed.state.status)) return "terminal";

    const onEvent = managed.conversation.sendToClient;
    const requestId = uuid();

    // If the session is busy, queue the message; otherwise process immediately.
    const result = managed.conversation.enqueueMessage(
      trimmed,
      [],
      onEvent,
      requestId,
    );
    if (result.rejected) {
      return "sent"; // error event already delivered via onEvent
    }
    if (!result.queued) {
      // Conversation is idle — send directly.  Fire-and-forget so we don't block.
      const messageId = await managed.conversation.persistUserMessage(
        trimmed,
        [],
      );
      managed.conversation
        .runAgentLoop(trimmed, messageId, onEvent)
        .catch((err) => {
          log.error({ subagentId, err }, "Subagent message processing failed");
        });
    }
    return "sent";
  }

  // ── Queries ───────────────────────────────────────────────────────────

  getState(subagentId: string): SubagentState | undefined {
    return this.subagents.get(subagentId)?.state;
  }

  getChildrenOf(parentConversationId: string): SubagentState[] {
    const children = this.parentToChildren.get(parentConversationId);
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

  /**
   * Update the parent sender for all active children of a session.
   * Called when the parent client reconnects to a new socket.
   */
  updateParentSender(
    parentConversationId: string,
    newSendToClient: (msg: ServerMessage) => void,
  ): void {
    const children = this.parentToChildren.get(parentConversationId);
    if (!children) return;

    for (const childId of children) {
      const managed = this.subagents.get(childId);
      if (managed && !TERMINAL_STATUSES.has(managed.state.status)) {
        managed.parentSendToClient = newSendToClient;
      }
    }
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
      managed.conversation.abort();
    }
    managed.conversation.dispose();
    this.subagents.delete(subagentId);

    // Remove from parent tracking.
    const parentId = managed.state.config.parentConversationId;
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
    error?: string,
  ): void {
    const managed = this.subagents.get(subagentId);
    if (!managed) return;

    // Idempotent terminal state guard.
    if (
      TERMINAL_STATUSES.has(managed.state.status) &&
      managed.state.status !== status
    ) {
      return;
    }

    managed.state.status = status;
    if (error !== undefined) managed.state.error = error;

    parentSendToClient({
      type: "subagent_status_changed",
      subagentId,
      status,
      error,
      usage: managed.state.usage,
    } as ServerMessage);
  }

  /**
   * Inject a completion/failure notification into the parent session
   * so the LLM automatically informs the user.
   */
  private notifyParent(
    managed: ManagedSubagent,
    outcome: "completed" | "failed",
    parentSendToClient: (msg: ServerMessage) => void,
  ): void {
    if (!this.onSubagentFinished) return;

    const { config } = managed.state;
    let message: string;

    if (outcome === "completed") {
      const silent = config.sendResultToUser === false;
      message =
        `[Subagent "${config.label}" completed]\n\n` +
        `Use subagent_read with subagent_id "${config.id}" to retrieve the full output.\n` +
        (silent
          ? `This subagent was spawned for internal processing. Read the result for your own use but do NOT share it with the user.\nDo NOT re-spawn this subagent.`
          : `Do NOT re-spawn this subagent — just read and share the results.`);
    } else {
      const error = managed.state.error ?? "Unknown error";
      message =
        `[Subagent "${config.label}" failed]\n\n` +
        `Error: ${error}\n` +
        `Do NOT re-spawn or retry this subagent unless the user explicitly asks.`;
    }

    const notification: SubagentNotificationInfo = {
      subagentId: config.id,
      label: config.label,
      status: outcome,
      conversationId: managed.state.conversationId,
      ...(outcome === "failed"
        ? { error: managed.state.error ?? "Unknown error" }
        : {}),
    };

    try {
      this.onSubagentFinished(
        config.parentConversationId,
        message,
        parentSendToClient,
        notification,
      );
    } catch (err) {
      log.error(
        { subagentId: config.id, err },
        "Failed to notify parent session",
      );
    }
  }
}

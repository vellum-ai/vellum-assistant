/**
 * Abstraction for generating commit messages across different triggers.
 *
 * Provides a seam for future LLM-powered enrichment without changing
 * the synchronous commit path.
 */

export interface CommitContext {
  workspaceDir: string;
  trigger: "turn" | "heartbeat" | "shutdown";
  sessionId?: string;
  turnNumber?: number;
  changedFiles: string[];
  timestampMs: number;
  /** Optional reason string (used by heartbeat to describe threshold exceeded). */
  reason?: string;
}

export interface CommitMessageResult {
  message: string;
  metadata?: Record<string, unknown>;
}

export interface CommitMessageProvider {
  /** Build a commit message synchronously for immediate use. */
  buildImmediateMessage(ctx: CommitContext): CommitMessageResult;
  /** Optional: enqueue async enrichment after commit succeeds. */
  enqueueEnrichment?(
    ctx: CommitContext & { commitHash: string },
  ): Promise<void>;
}

/**
 * Build a short summary of what changed from a list of file paths.
 */
function buildChangeSummary(files: string[]): string {
  if (files.length === 0) {
    return "workspace changes";
  }
  if (files.length === 1) {
    return files[0];
  }
  if (files.length <= 3) {
    return files.join(", ");
  }
  return `${files.slice(0, 2).join(", ")} and ${files.length - 2} more`;
}

/**
 * Default deterministic commit message provider.
 *
 * Produces identical output to the pre-refactor inline logic in
 * turn-commit.ts and heartbeat-service.ts.
 */
export class DefaultCommitMessageProvider implements CommitMessageProvider {
  buildImmediateMessage(ctx: CommitContext): CommitMessageResult {
    switch (ctx.trigger) {
      case "turn":
        return this.buildTurnMessage(ctx);
      case "heartbeat":
        return this.buildHeartbeatMessage(ctx);
      case "shutdown":
        return this.buildShutdownMessage(ctx);
    }
  }

  private buildTurnMessage(ctx: CommitContext): CommitMessageResult {
    const summary = buildChangeSummary(ctx.changedFiles);
    const timestamp = new Date(ctx.timestampMs).toISOString();
    const message = [
      `Turn: ${summary}`,
      "",
      `Session: ${ctx.sessionId}`,
      `Turn: ${ctx.turnNumber}`,
      `Timestamp: ${timestamp}`,
      `Files: ${ctx.changedFiles.length} changed`,
    ].join("\n");
    return { message };
  }

  private buildHeartbeatMessage(ctx: CommitContext): CommitMessageResult {
    const totalChanges = ctx.changedFiles.length;
    const reason = ctx.reason ?? `${totalChanges} files`;
    return {
      message: `auto-commit: heartbeat safety net (${totalChanges} files, ${reason})`,
      metadata: { trigger: "heartbeat", timestamp: ctx.timestampMs },
    };
  }

  private buildShutdownMessage(ctx: CommitContext): CommitMessageResult {
    const totalChanges = ctx.changedFiles.length;
    return {
      message: `auto-commit: shutdown safety net (${totalChanges} files)`,
      metadata: { trigger: "shutdown", timestamp: ctx.timestampMs },
    };
  }
}

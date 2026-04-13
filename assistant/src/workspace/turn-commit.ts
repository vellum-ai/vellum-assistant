/**
 * Turn-boundary commit logic for workspace git tracking.
 *
 * After each conversation turn (user message -> assistant response cycle),
 * this module checks the workspace for uncommitted changes and creates a
 * single git commit capturing all file modifications from that turn.
 *
 * Commits are awaited so they complete before the next turn starts,
 * preventing cross-turn attribution of file changes.
 */

import { existsSync, readFileSync } from "node:fs";

import { parseIdentityFields } from "../daemon/handlers/identity.js";
import { syncIdentityNameToPlatform } from "../platform/sync-identity.js";
import { getLogger } from "../util/logger.js";
import { getWorkspacePromptPath } from "../util/platform.js";
import { getEnrichmentService } from "./commit-message-enrichment-service.js";
import {
  type CommitContext,
  type CommitMessageProvider,
  DefaultCommitMessageProvider,
} from "./commit-message-provider.js";
import { getWorkspaceGitService } from "./git-service.js";
import type {
  CommitMessageSource,
  LLMFallbackReason,
} from "./provider-commit-message-generator.js";
import { getCommitMessageGenerator } from "./provider-commit-message-generator.js";

const log = getLogger("turn-commit");

export interface TurnCommitMetadata {
  /** Conversation/conversation identifier */
  conversationId: string;
  /** 1-based turn number within the conversation */
  turnNumber: number;
  /** ISO 8601 timestamp of when the turn completed */
  timestamp: string;
  /** Number of files changed in this turn */
  filesChanged: number;
}

/**
 * Attempt a turn-boundary commit for the workspace.
 *
 * Checks the workspace for uncommitted changes. If any are found,
 * creates a single commit with structured metadata.
 *
 * This function should be awaited so it completes before the next turn
 * starts. All errors are caught and logged to avoid disrupting the conversation.
 *
 * @param workspaceDir - Absolute path to the workspace directory
 * @param conversationId - Conversation/conversation identifier
 * @param turnNumber - 1-based turn number within the conversation
 * @param provider - Optional commit message provider (defaults to deterministic)
 * @param deadlineMs - Optional absolute deadline (Date.now()) after which the commit should be skipped
 */
export async function commitTurnChanges(
  workspaceDir: string,
  conversationId: string,
  turnNumber: number,
  provider?: CommitMessageProvider,
  deadlineMs?: number,
): Promise<void> {
  const messageProvider = provider ?? new DefaultCommitMessageProvider();
  try {
    const gitService = getWorkspaceGitService(workspaceDir);
    const commitStartMs = Date.now();

    // Attempt LLM message generation BEFORE entering commitIfDirty so
    // the LLM call never runs while holding the git mutex.
    // Only attempt LLM when:
    //   1. No custom provider was injected (respect caller contract)
    //   2. The workspace actually has pending changes (avoid wasting budget)
    let llmMessage: string | undefined;
    let commitMessageSource: CommitMessageSource = "deterministic";
    let llmFallbackReason: LLMFallbackReason | undefined;

    if (!provider) {
      // Guard: skip pre-check if deadline already elapsed to avoid unnecessary mutex contention
      let preClean = false;
      let candidateChangedFiles: string[] = [];
      if (!deadlineMs || Date.now() < deadlineMs) {
        try {
          const preStatus = await gitService.getStatus();
          preClean = preStatus.clean;
          if (!preClean) {
            candidateChangedFiles = [
              ...new Set([
                ...preStatus.staged,
                ...preStatus.modified,
                ...preStatus.untracked,
              ]),
            ];
          }
        } catch {
          // If we can't determine status, assume dirty so we don't skip the commit
        }
      }

      if (!preClean) {
        try {
          const generator = getCommitMessageGenerator();
          const result = await generator.generateCommitMessage(
            {
              workspaceDir,
              trigger: "turn",
              conversationId,
              turnNumber,
              changedFiles: candidateChangedFiles,
              timestampMs: Date.now(),
            },
            { deadlineMs, changedFiles: candidateChangedFiles },
          );
          commitMessageSource = result.source;
          llmFallbackReason = result.reason;
          if (result.source === "llm") {
            llmMessage = result.message;
          }
        } catch (llmErr) {
          // Never let LLM errors affect the commit path
          log.debug(
            { err: llmErr },
            "LLM commit message generation failed (non-fatal)",
          );
          llmFallbackReason = "provider_error";
        }
      }
    }

    const { committed, status } = await gitService.commitIfDirty(
      (st) => {
        const uniqueFiles = [
          ...new Set([...st.staged, ...st.modified, ...st.untracked]),
        ];

        const ctx: CommitContext = {
          workspaceDir,
          trigger: "turn",
          conversationId,
          turnNumber,
          changedFiles: uniqueFiles,
          timestampMs: Date.now(),
        };

        // Use LLM message if available, otherwise deterministic
        if (llmMessage) {
          return { message: llmMessage };
        }
        return messageProvider.buildImmediateMessage(ctx);
      },
      deadlineMs !== undefined ? { deadlineMs } : undefined,
    );

    const commitDurationMs = Date.now() - commitStartMs;

    if (committed) {
      const uniqueFiles = [
        ...new Set([...status.staged, ...status.modified, ...status.untracked]),
      ];
      log.info(
        {
          conversationId,
          turnNumber,
          filesChanged: uniqueFiles.length,
          durationMs: commitDurationMs,
          commitMessageSource,
          ...(llmFallbackReason ? { llmFallbackReason } : {}),
        },
        "Turn-boundary commit created",
      );

      // If IDENTITY.md changed, trigger a best-effort sync of the
      // assistant name to the platform record.  This acts as a fallback
      // for environments where fs.watch / inotify is unreliable (e.g.
      // container runtimes using gVisor or Docker-in-Docker).
      if (
        uniqueFiles.some(
          (f) => f === "IDENTITY.md" || f.endsWith("/IDENTITY.md"),
        )
      ) {
        try {
          const identityPath = getWorkspacePromptPath("IDENTITY.md");
          if (existsSync(identityPath)) {
            const content = readFileSync(identityPath, "utf-8");
            const fields = parseIdentityFields(content);
            if (fields.name) {
              syncIdentityNameToPlatform(fields.name);
            }
          }
        } catch (syncErr) {
          log.debug(
            { syncErr },
            "Identity sync after turn-commit failed (non-fatal)",
          );
        }
      }

      // Fire-and-forget enrichment — never blocks turn completion
      try {
        const commitHash = await gitService.getHeadHash();
        const ctx: CommitContext = {
          workspaceDir,
          trigger: "turn",
          conversationId,
          turnNumber,
          changedFiles: uniqueFiles,
          timestampMs: Date.now(),
        };
        getEnrichmentService().enqueue({
          workspaceDir,
          commitHash,
          context: ctx,
          gitService,
        });
      } catch (enrichErr) {
        log.debug({ enrichErr }, "Failed to enqueue enrichment (non-fatal)");
      }
    } else {
      log.debug(
        { conversationId, turnNumber, durationMs: commitDurationMs },
        "No workspace changes to commit for turn",
      );
    }
  } catch (err) {
    // Never let commit failures propagate — they must not affect the turn
    log.warn(
      { err, conversationId, turnNumber },
      "Failed to create turn-boundary commit (non-fatal)",
    );
  }
}

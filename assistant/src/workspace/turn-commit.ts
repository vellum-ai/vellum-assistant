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

import { getWorkspaceGitService } from './git-service.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('turn-commit');

export interface TurnCommitMetadata {
  /** Session/conversation identifier */
  sessionId: string;
  /** 1-based turn number within the session */
  turnNumber: number;
  /** ISO 8601 timestamp of when the turn completed */
  timestamp: string;
  /** Number of files changed in this turn */
  filesChanged: number;
}

/**
 * Build a commit message with structured metadata for a turn boundary commit.
 *
 * Format:
 * ```
 * Turn: <summary>
 *
 * Session: sess_xyz
 * Turn: 5
 * Timestamp: 2026-02-18T15:30:00Z
 * Files: 3 changed
 * ```
 */
function buildCommitMessage(summary: string, metadata: TurnCommitMetadata): string {
  return [
    `Turn: ${summary}`,
    '',
    `Session: ${metadata.sessionId}`,
    `Turn: ${metadata.turnNumber}`,
    `Timestamp: ${metadata.timestamp}`,
    `Files: ${metadata.filesChanged} changed`,
  ].join('\n');
}

/**
 * Build a short summary of what changed from a list of file paths.
 */
function buildChangeSummary(files: string[]): string {
  if (files.length === 0) {
    return 'workspace changes';
  }
  if (files.length === 1) {
    return files[0];
  }
  if (files.length <= 3) {
    return files.join(', ');
  }
  return `${files.slice(0, 2).join(', ')} and ${files.length - 2} more`;
}

/**
 * Attempt a turn-boundary commit for the workspace.
 *
 * Checks the workspace for uncommitted changes. If any are found,
 * creates a single commit with structured metadata.
 *
 * This function should be awaited so it completes before the next turn
 * starts. All errors are caught and logged to avoid disrupting the session.
 *
 * @param workspaceDir - Absolute path to the workspace directory
 * @param sessionId - Session/conversation identifier
 * @param turnNumber - 1-based turn number within the session
 */
export async function commitTurnChanges(
  workspaceDir: string,
  sessionId: string,
  turnNumber: number,
): Promise<void> {
  try {
    const gitService = getWorkspaceGitService(workspaceDir);

    // Atomic status check + commit within a single mutex lock to prevent
    // TOCTOU races with heartbeat commits.
    const { committed, status } = await gitService.commitIfDirty((st) => {
      const uniqueFiles = [...new Set([...st.staged, ...st.modified, ...st.untracked])];
      const timestamp = new Date().toISOString();
      const summary = buildChangeSummary(uniqueFiles);

      const metadata: TurnCommitMetadata = {
        sessionId,
        turnNumber,
        timestamp,
        filesChanged: uniqueFiles.length,
      };

      return { message: buildCommitMessage(summary, metadata) };
    });

    if (committed) {
      const uniqueFiles = [...new Set([...status.staged, ...status.modified, ...status.untracked])];
      log.info(
        { sessionId, turnNumber, filesChanged: uniqueFiles.length },
        'Turn-boundary commit created',
      );
    } else {
      log.debug({ sessionId, turnNumber }, 'No workspace changes to commit for turn');
    }
  } catch (err) {
    // Never let commit failures propagate — they must not affect the turn
    log.warn(
      { err, sessionId, turnNumber },
      'Failed to create turn-boundary commit (non-fatal)',
    );
  }
}

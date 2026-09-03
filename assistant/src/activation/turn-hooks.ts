/**
 * Turn-boundary hooks that keep activation progress in step with the
 * conversations the checklist launched.
 *
 * The agent loop calls these fire-and-forget: they own their own error
 * handling and never reject, so a regression here cannot fail a turn.
 * They take plain data rather than loop types, which keeps this module
 * importable (and testable) on its own.
 */

import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import type { ActivationArtifact } from "../api/responses/activation.js";
import type { AttachmentSourceType } from "../daemon/assistant-attachments.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import {
  bumpActivationStepCount,
  markActivationTurnComplete,
} from "./progress-store.js";

const log = getLogger("activation-turn-hooks");

/**
 * A file the assistant attached this turn, in the shape the loop already
 * has on hand (`PersistedAttachmentFile`): where it was read from, the
 * display name it was stored under, and which boundary the path belongs to.
 */
export interface ActivationAttachedFile {
  path: string;
  filename?: string | undefined;
  sourceType: AttachmentSourceType;
}

/**
 * The workspace-relative form of `path`, or `null` when it does not name a
 * file inside the workspace. Relative paths are read as workspace-relative
 * already. Separators are normalized to `/` so the stored path is the same
 * on every platform the clients render it on.
 */
function toWorkspacePath(workspaceDir: string, path: string): string | null {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const absolute = isAbsolute(trimmed)
    ? trimmed
    : resolve(workspaceDir, trimmed);
  const relativePath = relative(workspaceDir, absolute);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return relativePath.split(sep).join("/");
}

/**
 * Normalize this turn's attached files into checklist artifacts.
 *
 * Only files the assistant produced in its own workspace are recorded. A
 * host file the user approved a read of is dropped outright: its path names
 * a location on the user's machine, and the progress file is a synced
 * resource every client of this assistant reads. Everything kept is stored
 * workspace-relative for the same reason, so no absolute host path reaches
 * `GET /v1/activation/progress`.
 *
 * The display name falls back to the path's basename, which is what the
 * client renders on the file card.
 */
export function collectActivationArtifacts(
  attached: readonly ActivationAttachedFile[],
): ActivationArtifact[] {
  const workspaceDir = getWorkspaceDir();
  const artifacts: ActivationArtifact[] = [];
  for (const file of attached) {
    if (file.sourceType !== "sandbox_file") {
      continue;
    }
    const workspacePath = toWorkspacePath(workspaceDir, file.path);
    if (workspacePath === null) {
      continue;
    }
    const displayName =
      file.filename?.trim() || basename(workspacePath) || workspacePath;
    artifacts.push({ workspacePath, displayName });
  }
  return artifacts;
}

/**
 * Count one tool call against the activation task linked to this
 * conversation. A no-op when no task points at it.
 */
export function onActivationToolCall(conversationId: string): void {
  void bumpActivationStepCount(conversationId).catch((err: unknown) => {
    log.warn({ err, conversationId }, "Activation step bump failed");
  });
}

/**
 * Mark the activation task linked to this conversation done. A no-op when
 * no task points at it, and idempotent once one is done.
 */
export function onActivationTurnComplete(params: {
  conversationId: string;
  toolCallCount: number;
  attachedFiles: readonly ActivationAttachedFile[];
}): void {
  void markActivationTurnComplete({
    conversationId: params.conversationId,
    toolCallCount: params.toolCallCount,
    artifacts: collectActivationArtifacts(params.attachedFiles),
  }).catch((err: unknown) => {
    log.warn(
      { err, conversationId: params.conversationId },
      "Activation turn completion failed",
    );
  });
}

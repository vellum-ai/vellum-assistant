/**
 * Turn-boundary hooks that keep activation progress in step with the
 * conversations the checklist launched.
 *
 * The agent loop calls these fire-and-forget: they own their own error
 * handling and never reject, so a regression here cannot fail a turn.
 * They take plain data rather than loop types, which keeps this module
 * importable (and testable) on its own.
 */

import { basename } from "node:path";

import type { ActivationArtifact } from "../api/responses/activation.js";
import { getLogger } from "../util/logger.js";
import {
  bumpActivationStepCount,
  markActivationTurnComplete,
} from "./progress-store.js";

const log = getLogger("activation-turn-hooks");

/**
 * A file the assistant attached this turn, in the shape the loop already
 * has on hand (`DirectiveRequest`): the path it named plus the display
 * name it asked for, if any.
 */
export interface ActivationAttachedFile {
  path: string;
  filename?: string | undefined;
}

/**
 * Normalize this turn's attached files into checklist artifacts. Blank
 * paths are dropped and the display name falls back to the path's
 * basename, which is what the client renders on the file card.
 */
export function collectActivationArtifacts(
  attached: readonly ActivationAttachedFile[],
): ActivationArtifact[] {
  const artifacts: ActivationArtifact[] = [];
  for (const file of attached) {
    const workspacePath = file.path.trim();
    if (workspacePath.length === 0) {
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

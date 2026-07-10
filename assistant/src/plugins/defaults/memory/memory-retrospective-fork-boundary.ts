// ---------------------------------------------------------------------------
// Memory retrospective — fork-boundary detection.
// ---------------------------------------------------------------------------
//
// Shared between the retrospective job (scoping prior-`remember` dedup to the
// post-fork tail) and the startup orphan sweep (deciding whether a fork-kind
// retrospective row produced any post-fork output worth preserving as the
// next run's dedup baseline). Lives in its own module so the sweep doesn't
// have to import the job handler's full dependency graph.

import { getMessages } from "../../../persistence/conversation-crud.js";
import { getLogger } from "../../../util/logger.js";
import {
  MEMORY_RETROSPECTIVE_FORK_SOURCE,
  MEMORY_RETROSPECTIVE_INSTRUCTION_KIND,
} from "./memory-retrospective-constants.js";

const log = getLogger("memory-retrospective-fork-boundary");

/**
 * Locate the boundary timestamp between a fork-kind retrospective's copied
 * prefix and its post-fork tail. Scans from the end for the last message
 * whose metadata carries a `forkSourceMessageId` stamp (the last copied
 * source message); its `createdAt` is the boundary. The stamp's value may
 * point at any ancestor when the source was itself a fork
 * (`cloneForkMessageMetadata` preserves pre-existing values), so we only
 * check for presence, not equality. Returns `null` when no message carries a
 * stamp — either the fork's copied prefix is empty (a tail-only fork whose
 * inherited compaction covers the whole cutoff range copies nothing) or the
 * copied rows' stamps are unreadable; `loadRetrospectiveRunMessages`
 * disambiguates the two via the leading instruction row.
 */
export function findForkBoundaryCreatedAt(
  forkMessages: Array<{
    createdAt: number;
    metadata: string | null;
  }>,
): number | null {
  for (let i = forkMessages.length - 1; i >= 0; i--) {
    const row = forkMessages[i]!;
    if (!row.metadata) continue;
    try {
      const parsed = JSON.parse(row.metadata) as {
        forkSourceMessageId?: unknown;
      };
      if (typeof parsed.forkSourceMessageId === "string") {
        return row.createdAt;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Whether the row is a run-authored retrospective-instruction message
 * (`metadata.kind` stamped by the job when it appends the instruction).
 */
function isRetrospectiveInstructionRow(metadata: string | null): boolean {
  if (!metadata) {
    return false;
  }
  try {
    const parsed = JSON.parse(metadata) as { kind?: unknown };
    return parsed.kind === MEMORY_RETROSPECTIVE_INSTRUCTION_KIND;
  } catch {
    return false;
  }
}

/**
 * Load the messages a retrospective run produced itself, given the
 * retrospective conversation's `source` kind:
 *
 *   - **Fork-kind** rows carry the copied source prefix (the source's visible
 *     tail), so only the post-fork tail (messages strictly after the fork
 *     boundary) counts — scanning the whole row would attribute the source
 *     conversation's own turns to the retrospective. When no row carries a
 *     `forkSourceMessageId` stamp, the fork is run-authored end-to-end only
 *     if its first row is the run's own instruction message (the empty-prefix
 *     tail-only fork); a stampless fork WITHOUT a leading instruction row is
 *     indeterminate — attributing it would mine copied source tool calls as
 *     run output — and degrades to "produced none".
 *   - **Legacy-kind** rows start empty, so every message is the run's own.
 *
 * Returns `null` when the run's output cannot be determined (message load
 * failure, or the indeterminate stampless shape above) — callers degrade
 * (empty dedup baseline / "no output"). Best-effort: failures are logged,
 * never thrown.
 */
export function loadRetrospectiveRunMessages(
  conversationId: string,
  source: string | null | undefined,
): ReturnType<typeof getMessages> | null {
  let messages: ReturnType<typeof getMessages>;
  try {
    messages = getMessages(conversationId);
  } catch (err) {
    log.warn(
      { err, retrospectiveConversationId: conversationId },
      "memory-retrospective: failed to load retrospective messages; treating run as having produced none",
    );
    return null;
  }

  if (source === MEMORY_RETROSPECTIVE_FORK_SOURCE) {
    const boundaryCreatedAt = findForkBoundaryCreatedAt(messages);
    if (boundaryCreatedAt == null) {
      if (messages.length === 0) {
        return messages;
      }
      if (isRetrospectiveInstructionRow(messages[0]?.metadata ?? null)) {
        // Empty copied prefix — the run's instruction opens the conversation,
        // so every message is the run's own output.
        return messages;
      }
      log.warn(
        { retrospectiveConversationId: conversationId },
        "memory-retrospective: fork-kind retrospective has no forkSourceMessageId stamps and no leading instruction row; treating run as having produced none",
      );
      return null;
    }
    return messages.filter((m) => m.createdAt > boundaryCreatedAt);
  }

  return messages;
}

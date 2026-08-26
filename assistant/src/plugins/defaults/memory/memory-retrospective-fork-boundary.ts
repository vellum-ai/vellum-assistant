// ---------------------------------------------------------------------------
// Memory retrospective — fork-boundary detection.
// ---------------------------------------------------------------------------
//
// Shared between the retrospective job (scoping prior-`remember` dedup to the
// post-fork tail) and the startup orphan sweep (deciding whether a fork-kind
// retrospective row produced any post-fork output worth preserving as the
// next run's dedup baseline). Lives in its own module so the sweep doesn't
// have to import the job handler's full dependency graph.

import { getConversation, getMessages } from "@vellumai/plugin-api";

import { isReferentialFork } from "../../../persistence/conversation-lineage.js";
import { getLogger } from "./logging.js";
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
    if (!row.metadata) {
      continue;
    }
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
 *   - **Fork-kind, referential** (`fork_strategy = "reference"`): the fork
 *     copies no prefix. Inherited history is read through lineage and keeps
 *     the source `conversationId`. Every row owned by the fork is the run's
 *     own output, including when that set is empty.
 *   - **Fork-kind, cloning**: rows carry the copied source prefix (the
 *     source's visible tail), so only the post-fork tail (messages strictly
 *     after the fork boundary) counts. Scanning the whole list would
 *     attribute the source conversation's own turns to the retrospective.
 *     When no row carries a `forkSourceMessageId` stamp, the fork is
 *     run-authored end-to-end only if its first row is the run's own
 *     instruction message (the empty-prefix tail-only fork). A stampless
 *     fork WITHOUT a leading instruction row is indeterminate: attributing
 *     it would mine copied source tool calls as run output, so the helper
 *     degrades to "produced none".
 *   - **Legacy-kind** rows start empty, so every message is the run's own.
 *
 * Returns `null` when the run's output cannot be determined (message load
 * failure, or the indeterminate stampless cloning shape above). Callers
 * degrade (empty dedup baseline / "no output"). Best-effort: failures are
 * logged, never thrown.
 */
export async function loadRetrospectiveRunMessages(
  conversationId: string,
  source: string | null | undefined,
): Promise<Awaited<ReturnType<typeof getMessages>> | null> {
  let messages: Awaited<ReturnType<typeof getMessages>>;
  try {
    messages = await getMessages(conversationId);
  } catch (err) {
    log.warn(
      { err, retrospectiveConversationId: conversationId },
      "memory-retrospective: failed to load retrospective messages; treating run as having produced none",
    );
    return null;
  }

  if (source === MEMORY_RETROSPECTIVE_FORK_SOURCE) {
    try {
      const conversation = await getConversation(conversationId);
      if (conversation && isReferentialFork(conversation)) {
        // Referential forks copy nothing. Lineage-aware `getMessages` still
        // returns the inherited source rows, which keep the source
        // `conversationId`. Owned rows are the run.
        return messages.filter((m) => m.conversationId === conversationId);
      }
    } catch (err) {
      log.warn(
        { err, retrospectiveConversationId: conversationId },
        "memory-retrospective: failed to load retrospective conversation; falling back to copied-prefix boundary scan",
      );
    }

    const boundaryCreatedAt = findForkBoundaryCreatedAt(messages);
    if (boundaryCreatedAt == null) {
      if (messages.length === 0) {
        return messages;
      }
      if (isRetrospectiveInstructionRow(messages[0]?.metadata ?? null)) {
        // Empty copied prefix. The run's instruction opens the conversation,
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

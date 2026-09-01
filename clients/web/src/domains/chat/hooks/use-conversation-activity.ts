/**
 * Conversation-scoped activity feed for the header Activity control: the
 * subagents and ACP runs belonging to one conversation, split into still-running
 * and finished.
 *
 * The running halves delegate to `useActiveSubagentIds` / `useActiveAcpRunIds`
 * so the parent-scoping rules stay in one place per kind (they differ: a
 * subagent with no parent id is unknown-and-visible, an ACP run's parent is a
 * required-but-possibly-empty string). The completed halves invert those on
 * status, and the ACP one additionally requires ownership; see its docstring.
 *
 * Only these two kinds are included. Workflows and background tools have their
 * own surfaces and are deliberately out of scope here.
 */

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { useActiveAcpRunIds } from "@/domains/chat/hooks/use-active-acp-run-ids";
import { useActiveSubagentIds } from "@/domains/chat/hooks/use-active-subagent-ids";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { isActiveAcpStatus } from "@/utils/acp-run-status";
import { isActiveStatus } from "@/utils/subagent-status";

import type { ProcessKind } from "@/domains/chat/process-registry/types";

/** One process in the conversation's activity list. */
export interface ConversationActivityRow {
  /** Which descriptor renders this row. */
  kind: Extract<ProcessKind, "subagent" | "acp-run">;
  /** Process id within that kind. */
  id: string;
}

export interface ConversationActivity {
  /** Still-running processes, oldest first: the order they were spawned in. */
  running: ConversationActivityRow[];
  /** Finished processes, most recent first: the one just finished reads top. */
  completed: ConversationActivityRow[];
  /** Total across both halves; `0` means the control hides entirely. */
  total: number;
}

/**
 * Finished subagent ids for `conversationId`. Mirrors `useActiveSubagentIds`'
 * scoping rule, including its treatment of an entry whose parent is not yet
 * known as belonging to whatever conversation is asking, inverted on status.
 */
export function useCompletedSubagentIds(
  conversationId: string | null,
): string[] {
  return useSubagentStore(
    useShallow((s) =>
      s.orderedIds.filter((id) => {
        const entry = s.byId[id];
        if (entry?.status === undefined || isActiveStatus(entry.status)) {
          return false;
        }
        return (
          entry.parentConversationId === undefined ||
          entry.parentConversationId === conversationId
        );
      }),
    ),
  );
}

/**
 * Finished ACP run ids for `conversationId`.
 *
 * Ownership is required here, unlike `useActiveAcpRunIds`, which keeps a run
 * whose `parentConversationId` is empty rather than hiding it. Rehydration
 * stamps `""` when a persisted row carries no parent (`toRunEntry`), and the
 * ACP store is never reset on a conversation change, so treating an empty
 * parent as a match would leave every unattributable finished run in the list
 * of every conversation for the rest of the session: an inflated count, and
 * rows that open a run belonging to a different chat. A live run is worth
 * surfacing on weaker evidence because it is short-lived and the user is
 * waiting on it; a finished one is not.
 */
export function useCompletedAcpRunIds(conversationId: string | null): string[] {
  return useAcpRunStore(
    useShallow((s) =>
      s.orderedIds.filter((id) => {
        const entry = s.byId[id];
        if (entry?.status === undefined || isActiveAcpStatus(entry.status)) {
          return false;
        }
        return (
          !!entry.parentConversationId &&
          entry.parentConversationId === conversationId
        );
      }),
    ),
  );
}

/**
 * Start timestamp for one row. Read non-reactively: `spawnedAt` / `startedAt`
 * are stamped once at creation and never mutate, so a subscription would only
 * add re-renders. A row whose entry has since been evicted sorts last rather
 * than throwing.
 */
function startedAt(row: ConversationActivityRow): number {
  if (row.kind === "subagent") {
    return useSubagentStore.getState().byId[row.id]?.spawnedAt ?? 0;
  }
  return useAcpRunStore.getState().byId[row.id]?.startedAt ?? 0;
}

/**
 * The conversation's subagents and ACP runs, merged across kinds and ordered by
 * start time so the two read as one activity list rather than two concatenated
 * per-kind blocks.
 */
export function useConversationActivity(
  conversationId: string | null,
): ConversationActivity {
  const runningSubagentIds = useActiveSubagentIds(conversationId);
  const runningAcpRunIds = useActiveAcpRunIds(conversationId);
  const completedSubagentIds = useCompletedSubagentIds(conversationId);
  const completedAcpRunIds = useCompletedAcpRunIds(conversationId);

  return useMemo(() => {
    const toRows = (
      ids: string[],
      kind: ConversationActivityRow["kind"],
    ): ConversationActivityRow[] => ids.map((id) => ({ kind, id }));

    const running = [
      ...toRows(runningSubagentIds, "subagent"),
      ...toRows(runningAcpRunIds, "acp-run"),
    ].sort((a, b) => startedAt(a) - startedAt(b));

    const completed = [
      ...toRows(completedSubagentIds, "subagent"),
      ...toRows(completedAcpRunIds, "acp-run"),
    ].sort((a, b) => startedAt(b) - startedAt(a));

    return { running, completed, total: running.length + completed.length };
  }, [
    runningSubagentIds,
    runningAcpRunIds,
    completedSubagentIds,
    completedAcpRunIds,
  ]);
}

/**
 * How far before the first still-running session a finished one may have
 * started and still count as part of the same run.
 *
 * A batch is spawned in a burst, but not atomically: siblings land milliseconds
 * or a second or two apart, and a fast one can finish before the last of its
 * own batch is even created. Without the tolerance that sibling would sort
 * before the earliest running session and be filed as history. Small enough
 * that a genuinely earlier run, which is separated by however long its work
 * took, never slips in.
 */
const RUN_START_TOLERANCE_MS = 2_000;

/**
 * The CURRENT run's sessions: everything still working, plus the finished ones
 * from the same batch.
 *
 * The floating agents control is about what is happening now. Listing every
 * session the conversation ever produced turned it into a transcript of its
 * own, where the live work was buried under runs that ended minutes ago and the
 * same agent name appeared several times from different batches.
 *
 * "The same batch" is defined against the earliest session still running: the
 * run began when that one started, so anything from before it is a previous
 * run. Sessions are the unit here rather than the spawning message, because ACP
 * runs carry no message identity and would otherwise need a second rule.
 *
 * With nothing running there is no current run, and this reports empty, which
 * is also when the floating control is hidden anyway.
 */
export function useCurrentRunActivity(
  conversationId: string | null,
): ConversationActivity {
  const activity = useConversationActivity(conversationId);

  return useMemo(() => {
    const { running } = activity;
    if (running.length === 0) {
      return { running: [], completed: [], total: 0 };
    }
    const runStartedAt =
      Math.min(...running.map(startedAt)) - RUN_START_TOLERANCE_MS;
    const completed = activity.completed.filter(
      (row) => startedAt(row) >= runStartedAt,
    );
    return { running, completed, total: running.length + completed.length };
  }, [activity]);
}

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

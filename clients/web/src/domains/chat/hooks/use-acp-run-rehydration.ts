/**
 * Rehydrate ACP runs from the daemon on conversation load and on SSE reconnect.
 *
 * On conversation change, fetch `/acp/sessions` for the active conversation
 * and `seedFromHistory` the acp-run store: completed and in-progress runs
 * reappear with their event timelines, terminal status, and usage.
 *
 * Also re-seed when the SSE stream reopens after a drop (sleep, flaky network,
 * backgrounding). ACP events emitted during the outage aren't ring-replayed —
 * they carry no `conversationId`, so the daemon's reconnect replay skips them —
 * leaving a stale transcript/status until the user navigates away. Re-fetching
 * routes the catch-up through the seed path. Mirrors the conversation-history
 * hook's reconnect refetch.
 *
 * Seeding sets each run's `highWaterMark` to the max `seq` over its events.
 * The live SSE handler drops updates whose `seq <= highWaterMark`, so events
 * already in a seeded buffer are not re-applied when streaming resumes. For an
 * active run whose ring buffer was trimmed (>200 events), a small replay window
 * may slip past the mark; the step projection is idempotent on `toolCallId` and
 * tolerant of repeated message chunks, so the duplicate window is harmless.
 */

import { useEffect } from "react";

import { useBusSubscription } from "@/hooks/use-bus-subscription";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { captureError } from "@/lib/sentry/capture-error";
import {
  useAcpRunStore,
  type AcpRunEntry,
  type AcpRunRawEvent,
} from "@/domains/chat/acp-run-store";
import { type AcpRunStatus } from "@/utils/acp-run-status";

interface AcpSessionEventLogItem {
  updateType?: AcpRunRawEvent["updateType"];
  content?: string;
  toolCallId?: string;
  toolTitle?: string;
  toolKind?: string;
  toolStatus?: string;
  locations?: { path: string; line?: number }[];
  messageId?: string;
  seq?: number;
}

interface AcpSessionRow {
  // Vellum ACP session id — the key SSE events and steer/cancel routes address.
  // The store is keyed by this, NOT the agent-protocol `acpSessionId`.
  id: string;
  acpSessionId: string;
  agentId?: string;
  agent?: string;
  parentConversationId?: string;
  parentToolUseId?: string;
  task?: string;
  status: string;
  stopReason?: string | null;
  error?: string | null;
  startedAt?: number;
  completedAt?: number | null;
  usedTokens?: number;
  contextSize?: number;
  inputTokens?: number;
  outputTokens?: number;
  costAmount?: number;
  costCurrency?: string;
  eventLog?: AcpSessionEventLogItem[];
}

interface AcpSessionsResponse {
  sessions?: AcpSessionRow[];
}

// Status-keyed response map (type alias, not interface) so the HeyAPI client's
// `data` unwraps to the 200 body — an interface lacks the implicit index
// signature the unwrap conditional needs.
type AcpSessionsResponses = {
  200: AcpSessionsResponse;
};

const TERMINAL_STATUSES = new Set<AcpRunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

/** Map a daemon session status string onto an {@link AcpRunStatus}. */
function toRunStatus(status: string): AcpRunStatus {
  if (TERMINAL_STATUSES.has(status as AcpRunStatus))
    return status as AcpRunStatus;
  return status === "initializing" ? "initializing" : "running";
}

function toRawEvents(eventLog: AcpSessionEventLogItem[]): AcpRunRawEvent[] {
  const events: AcpRunRawEvent[] = [];
  for (const item of eventLog) {
    if (!item.updateType) continue;
    // Leave `seq` undefined when the persisted item lacks one (event logs from
    // older daemons). The store keeps seqless events out of the high-water mark,
    // matching the daemon, which seeds its resume counter from numeric seqs only
    // — a synthetic index here would make the client drop the first live updates
    // after resume as phantom replays.
    events.push({
      seq: item.seq,
      updateType: item.updateType,
      content: item.content,
      toolCallId: item.toolCallId,
      toolTitle: item.toolTitle,
      toolKind: item.toolKind,
      toolStatus: item.toolStatus,
      locations: item.locations,
      messageId: item.messageId,
    });
  }
  return events;
}

function toRunEntry(row: AcpSessionRow): AcpRunEntry {
  const status = toRunStatus(row.status);
  const isTerminal = TERMINAL_STATUSES.has(status);
  const events = toRawEvents(row.eventLog ?? []);

  return {
    acpSessionId: row.id,
    agent: row.agent ?? row.agentId ?? "",
    parentConversationId: row.parentConversationId ?? "",
    task: row.task,
    status,
    stopReason: isTerminal ? (row.stopReason ?? undefined) : undefined,
    error: isTerminal ? (row.error ?? undefined) : undefined,
    startedAt: row.startedAt ?? Date.now(),
    completedAt: isTerminal ? (row.completedAt ?? undefined) : undefined,
    parentToolUseId: row.parentToolUseId,
    usedTokens: row.usedTokens ?? 0,
    contextSize: row.contextSize ?? 0,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costAmount: row.costAmount,
    costCurrency: row.costCurrency,
    events,
  };
}

export async function fetchAcpSessions(
  assistantId: string,
  conversationId: string,
): Promise<AcpRunEntry[]> {
  try {
    const { data, response } = await daemonClient.get<AcpSessionsResponses>({
      url: "/v1/assistants/{assistant_id}/acp/sessions",
      path: { assistant_id: assistantId },
      query: { conversationId },
      throwOnError: false,
    });
    if (!response?.ok || !data?.sessions) return [];
    return data.sessions
      .filter((row): row is AcpSessionRow => !!row?.id)
      .map(toRunEntry);
  } catch (err) {
    captureError(err, { context: "fetchAcpSessions" });
    return [];
  }
}

export function useAcpRunRehydration(
  assistantId: string | null,
  conversationId: string | null,
): void {
  useEffect(() => {
    if (!assistantId || !conversationId) return;
    let cancelled = false;
    void fetchAcpSessions(assistantId, conversationId).then((entries) => {
      if (cancelled || entries.length === 0) return;
      useAcpRunStore.getState().seedFromHistory(entries);
    });
    return () => {
      cancelled = true;
    };
  }, [assistantId, conversationId]);

  // Re-seed on SSE reopen so a connection that dropped past the daemon's replay
  // ring doesn't leave a stale ACP transcript. `fresh`/`anchor` opens are
  // skipped — the conversation-change effect above already owns the initial
  // load. `seedFromHistory` merges by `seq` and raises the high-water mark, so
  // re-seeding is idempotent against events already streamed.
  useBusSubscription(
    "sse.opened",
    ({ assistantId: openedAssistantId, cause }) => {
      if (cause === "fresh" || cause === "anchor") return;
      if (!assistantId || !conversationId || openedAssistantId !== assistantId) {
        return;
      }
      void fetchAcpSessions(assistantId, conversationId).then((entries) => {
        if (entries.length === 0) return;
        useAcpRunStore.getState().seedFromHistory(entries);
      });
    },
  );
}

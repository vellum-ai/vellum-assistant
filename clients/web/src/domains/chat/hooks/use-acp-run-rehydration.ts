/**
 * Rehydrate ACP runs from the daemon on conversation load.
 *
 * On conversation change, fetch `/acp/sessions` for the active conversation
 * and `seedFromHistory` the acp-run store: completed and in-progress runs
 * reappear with their event timelines, terminal status, and usage.
 *
 * Seeding sets each run's `highWaterMark` to the max `seq` over its events.
 * The live SSE handler drops updates whose `seq <= highWaterMark`, so events
 * already in a seeded buffer are not re-applied when streaming resumes. For an
 * active run whose ring buffer was trimmed (>200 events), a small replay window
 * may slip past the mark; the step projection is idempotent on `toolCallId` and
 * tolerant of repeated message chunks, so the duplicate window is harmless.
 */

import { useEffect } from "react";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { useAcpRunStore, type AcpRunEntry, type AcpRunRawEvent } from "@/domains/chat/acp-run-store";
import { type AcpRunStatus } from "@/utils/acp-run-status";

interface AcpSessionEventLogItem {
  updateType?: AcpRunRawEvent["updateType"];
  content?: string;
  toolCallId?: string;
  toolTitle?: string;
  toolKind?: string;
  toolStatus?: string;
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

const TERMINAL_STATUSES = new Set<AcpRunStatus>(["completed", "failed", "cancelled"]);

/** Map a daemon session status string onto an {@link AcpRunStatus}. */
function toRunStatus(status: string): AcpRunStatus {
  if (TERMINAL_STATUSES.has(status as AcpRunStatus)) return status as AcpRunStatus;
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
    stopReason: isTerminal ? row.stopReason ?? undefined : undefined,
    error: isTerminal ? row.error ?? undefined : undefined,
    startedAt: row.startedAt ?? Date.now(),
    completedAt: isTerminal ? row.completedAt ?? undefined : undefined,
    parentToolUseId: row.parentToolUseId,
    usedTokens: row.usedTokens ?? 0,
    contextSize: row.contextSize ?? 0,
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
}

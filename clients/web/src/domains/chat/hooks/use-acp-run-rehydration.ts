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

interface AcpSessionUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalCost?: number;
}

interface AcpSessionRow {
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
  usage?: AcpSessionUsage;
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
  for (const [index, item] of eventLog.entries()) {
    if (!item.updateType) continue;
    events.push({
      seq: item.seq ?? index,
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
    acpSessionId: row.acpSessionId,
    agent: row.agent ?? row.agentId ?? "",
    parentConversationId: row.parentConversationId ?? "",
    task: row.task,
    status,
    stopReason: isTerminal ? row.stopReason ?? undefined : undefined,
    error: isTerminal ? row.error ?? undefined : undefined,
    startedAt: row.startedAt ?? Date.now(),
    completedAt: isTerminal ? row.completedAt ?? undefined : undefined,
    parentToolUseId: row.parentToolUseId,
    inputTokens: row.usage?.inputTokens ?? 0,
    outputTokens: row.usage?.outputTokens ?? 0,
    totalCost: row.usage?.totalCost ?? 0,
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
      .filter((row): row is AcpSessionRow => !!row?.acpSessionId)
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

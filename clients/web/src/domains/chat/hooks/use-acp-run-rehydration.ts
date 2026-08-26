/**
 * Rehydrate ACP runs from the daemon on conversation load and on SSE reconnect.
 *
 * On conversation change, fetch `/acp/sessions` for the active conversation
 * and `seedFromHistory` the acp-run store: completed and in-progress runs
 * reappear with their event timelines, terminal status, and usage.
 *
 * Also reconcile when the SSE stream reopens after a drop (sleep, flaky
 * network, backgrounding). ACP events emitted during the outage aren't
 * ring-replayed — they carry no `conversationId`, so the daemon's reconnect
 * replay skips them — leaving a stale transcript/status until the user
 * navigates away. Re-fetching routes the catch-up through the seed path, and an
 * authoritative snapshot that no longer reports a previously-active run retires
 * it (the daemon restarted and lost an unpersisted subprocess).
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
import { isActiveAcpStatus, type AcpRunStatus } from "@/utils/acp-run-status";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { SYNC_TAGS } from "@/lib/sync/types";
import { ACP_CLAUDE_AUTH_REQUIRED_CODE } from "@/domains/chat/utils/acp-connect";

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
  rawInput?: unknown;
  rawOutput?: unknown;
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
  authErrorCode?: string;
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
  if (TERMINAL_STATUSES.has(status as AcpRunStatus)) {
    return status as AcpRunStatus;
  }
  return status === "initializing" ? "initializing" : "running";
}

function toRawEvents(eventLog: AcpSessionEventLogItem[]): AcpRunRawEvent[] {
  const events: AcpRunRawEvent[] = [];
  for (const item of eventLog) {
    if (!item.updateType) {
      continue;
    }
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
      rawInput: item.rawInput,
      rawOutput: item.rawOutput,
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
    authErrorCode: row.authErrorCode,
    usedTokens: row.usedTokens ?? 0,
    contextSize: row.contextSize ?? 0,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costAmount: row.costAmount,
    costCurrency: row.costCurrency,
    events,
  };
}

/**
 * Page size requested from `/acp/sessions` (matches the route's own default).
 * Doubles as a completeness signal: the route returns sessions newest-first
 * and slices to this limit, so a full page may have dropped an older
 * still-running run. Snapshots returning fewer than this are authoritative;
 * a full page is treated as possibly-truncated (see `applyAcpSnapshot`).
 */
const ACP_SNAPSHOT_LIMIT = 50;

/**
 * Fetch the authoritative ACP session snapshot for a conversation. Returns
 * `null` on a failed/non-ok fetch so callers can distinguish "couldn't load"
 * from an authoritative empty snapshot (which must retire stale runs).
 */
export async function fetchAcpSessions(
  assistantId: string,
  conversationId: string,
): Promise<AcpRunEntry[] | null> {
  try {
    const { data, response } = await daemonClient.get<AcpSessionsResponses>({
      url: "/v1/assistants/{assistant_id}/acp/sessions",
      path: { assistant_id: assistantId },
      query: { conversationId, limit: ACP_SNAPSHOT_LIMIT },
      throwOnError: false,
    });
    if (!response?.ok || !data?.sessions) {
      return null;
    }
    return data.sessions
      .filter((row): row is AcpSessionRow => !!row?.id)
      .map(toRunEntry);
  } catch (err) {
    captureError(err, { context: "fetchAcpSessions" });
    return null;
  }
}

/**
 * Re-raise the inline Connect card for a run the daemon says died on a
 * credential failure.
 *
 * The snapshot is the authoritative source for this, not the transcript. The
 * row carries the failure, the conversation that owns it and the spawning tool
 * call the card anchors to, and the daemon clears the failure when a
 * replacement token is stored, so a repaired rejection stops re-raising on its
 * own. The live `acp_auth_required` event covers the session that watched the
 * failure happen; this covers every reopen after it.
 *
 * Stops at the first eligible row. The snapshot arrives newest-first
 * (`listMergedSessions` orders by descending `startedAt`), so the first match
 * is the most recent failure; carrying on would let each later, older row
 * overwrite it. `showAcpConnect` no-ops a prompt already retired this session,
 * so a reconcile cannot resurrect one the user dismissed.
 */
export function raiseAcpConnectFromSnapshot(entries: AcpRunEntry[]): void {
  for (const entry of entries) {
    if (
      entry.authErrorCode !== ACP_CLAUDE_AUTH_REQUIRED_CODE ||
      entry.status === "cancelled" ||
      !entry.parentToolUseId
    ) {
      continue;
    }
    useInteractionStore.getState().showAcpConnect({
      toolUseId: entry.parentToolUseId,
      reason: "auth_required",
      conversationId: entry.parentConversationId || null,
    });
    return;
  }
}

/** Active run ids in the store that belong to `conversationId`. */
function activeRunIdsFor(conversationId: string): string[] {
  const { byId, orderedIds } = useAcpRunStore.getState();
  return orderedIds.filter((id) => {
    const entry = byId[id];
    return (
      !!entry &&
      isActiveAcpStatus(entry.status) &&
      entry.parentConversationId === conversationId
    );
  });
}

/**
 * Apply an authoritative snapshot: seed the reported runs and retire any run
 * that was active in the store for this conversation but is absent from the
 * snapshot — the daemon restarted and lost it. `priorActiveIds` is captured
 * before the fetch so a run spawned live during the round-trip (not yet in the
 * daemon's snapshot) is never retired. A `null` snapshot means the fetch
 * failed, so nothing is reconciled.
 *
 * A full page (>= `ACP_SNAPSHOT_LIMIT`) may have paginated an older
 * still-running run off the snapshot, so absence isn't authoritative there —
 * we seed but skip retirement rather than risk cancelling a live run.
 */
function applyAcpSnapshot(
  entries: AcpRunEntry[] | null,
  priorActiveIds: string[],
): void {
  if (entries === null) {
    return;
  }
  const store = useAcpRunStore.getState();
  if (entries.length > 0) {
    store.seedFromHistory(entries);
    raiseAcpConnectFromSnapshot(entries);
  }
  if (entries.length >= ACP_SNAPSHOT_LIMIT) {
    return;
  }
  const present = new Set(entries.map((e) => e.acpSessionId));
  const missing = priorActiveIds.filter((id) => !present.has(id));
  if (missing.length > 0) {
    store.retireMissingRuns({
      acpSessionIds: missing,
      completedAt: Date.now(),
    });
  }
}

export function useAcpRunRehydration(
  assistantId: string | null,
  conversationId: string | null,
): void {
  useEffect(() => {
    if (!assistantId || !conversationId) {
      return;
    }
    let cancelled = false;
    const priorActiveIds = activeRunIdsFor(conversationId);
    void fetchAcpSessions(assistantId, conversationId).then((entries) => {
      if (cancelled) {
        return;
      }
      applyAcpSnapshot(entries, priorActiveIds);
    });
    return () => {
      cancelled = true;
    };
  }, [assistantId, conversationId]);

  // Reconcile on SSE reopen so a connection that dropped past the daemon's
  // replay ring doesn't leave a stale ACP transcript — and so a run whose
  // daemon restarted (lost subprocess, never persisted) is retired rather than
  // stuck `running`. `fresh`/`anchor` opens are skipped — the conversation
  // effect above already owns the initial load. Seeding merges by `seq` and is
  // idempotent against events already streamed.
  // A token write on any client retires the daemon's auth markers and
  // publishes this tag. Another client holding a restored `auth_required`
  // prompt cannot discover that on its own: the prompt deliberately skips the
  // connected-state self-heal, and nothing refetches the snapshot until
  // navigation or reconnect, so it would keep offering Connect for the token
  // that was just replaced. Retire the prompt and re-read the snapshot, which
  // now carries no marker.
  useBusSubscription("sse.event", (envelope) => {
    const message = envelope.message;
    if (
      message.type !== "sync_changed" ||
      !message.tags?.includes(SYNC_TAGS.acpAuthRecovery)
    ) {
      return;
    }
    if (useInteractionStore.getState().pendingAcpConnect) {
      useInteractionStore.getState().dismissAcpConnect();
    }
    if (!assistantId || !conversationId) {
      return;
    }
    const priorActiveIds = activeRunIdsFor(conversationId);
    void fetchAcpSessions(assistantId, conversationId).then((entries) => {
      applyAcpSnapshot(entries, priorActiveIds);
    });
  });

  useBusSubscription(
    "sse.opened",
    ({ assistantId: openedAssistantId, cause }) => {
      if (cause === "fresh" || cause === "anchor") {
        return;
      }
      if (
        !assistantId ||
        !conversationId ||
        openedAssistantId !== assistantId
      ) {
        return;
      }
      const priorActiveIds = activeRunIdsFor(conversationId);
      void fetchAcpSessions(assistantId, conversationId).then((entries) => {
        applyAcpSnapshot(entries, priorActiveIds);
      });
    },
  );
}

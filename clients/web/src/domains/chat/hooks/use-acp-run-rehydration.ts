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

import { useEffect, useRef } from "react";

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
export function raiseAcpConnectFromSnapshot(
  entries: AcpRunEntry[],
  snapshotConversationId: string | null = null,
  revisionAtFetch: number = useInteractionStore.getState().acpConnectRevision,
): void {
  // A response can be older than the prompt on screen: requested before a
  // newer run failed, delivered after its live event raised the newest anchor.
  // Raising from it would replace that prompt with an older one, so a snapshot
  // that no longer speaks for the current prompt raises nothing and retires
  // nothing.
  if (useInteractionStore.getState().acpConnectRevision !== revisionAtFetch) {
    // Stale for raising and retiring, but not for saying who owns the prompt
    // that overtook it. That prompt may have come from the live
    // `acp_auth_required` event, which is global and carries no conversation,
    // so a client that missed the run's spawn event recorded it with none and
    // the card renders only inline under its anchor row.
    adoptAcpConnectOwnerFromSnapshot(entries);
    return;
  }
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
  // No marker in an authoritative snapshot means the daemon retired it, which
  // a client that was disconnected when the token landed never heard. Its
  // prompt skips the connected-state self-heal and survives conversation
  // resets, so without this the stale card outlives the reconnect that should
  // have cleared it. Scoped to the conversation the snapshot covers.
  retireStaleAcpConnectPrompt(snapshotConversationId, revisionAtFetch);
}

/**
 * Fill in the conversation for a prompt that was raised without one.
 *
 * Matched on the tool-use id, so this only ever describes the prompt already
 * on screen. That makes it safe from a snapshot too old to raise or retire
 * anything: an older response still knows which conversation started a given
 * run, because that never changes.
 */
function adoptAcpConnectOwnerFromSnapshot(entries: AcpRunEntry[]): void {
  const prompt = useInteractionStore.getState().pendingAcpConnect;
  if (!prompt || prompt.conversationId) {
    return;
  }
  const owner = entries.find(
    (entry) =>
      entry.parentToolUseId === prompt.toolUseId && entry.parentConversationId,
  );
  if (!owner?.parentConversationId) {
    return;
  }
  useInteractionStore
    .getState()
    .adoptAcpConnectConversation(owner.parentConversationId);
}

/**
 * Drop a restored `auth_required` prompt the daemon no longer backs.
 *
 * Left alone while this tab owns a live Connect flow: that flow's own token
 * write is what triggers the invalidation, and clearing the card underneath it
 * loses both the success confirmation and the auto-continue it is about to
 * request.
 */
function retireStaleAcpConnectPrompt(
  conversationId: string | null,
  revisionAtFetch: number,
): void {
  const state = useInteractionStore.getState();
  const prompt = state.pendingAcpConnect;
  if (state.acpConnectFlowActive || !prompt) {
    return;
  }
  // A snapshot only speaks for the prompt that existed when it was requested.
  // A fetch issued before a live `acp_auth_required` can land after it, and
  // retiring on that would dismiss a prompt the daemon just raised, recording
  // its tool-use id and stopping any later snapshot from restoring the card.
  if (state.acpConnectRevision !== revisionAtFetch) {
    return;
  }
  // Only the prompt this snapshot can speak for. A missing-token failure is
  // not represented in ACP session history at all, so an absent marker says
  // nothing about it, and dismissing records the tool-use id, which would stop
  // the transcript reseed from ever restoring that card while the model's
  // guidance still points at it. Likewise a prompt owned by another
  // conversation, which this snapshot did not cover.
  if (
    prompt.reason !== "auth_required" ||
    (prompt.conversationId != null && prompt.conversationId !== conversationId)
  ) {
    return;
  }
  state.dismissAcpConnect();
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
/**
 * Newest snapshot request issued per conversation.
 *
 * The prompt revision cannot order two responses on its own. It moves when the
 * prompt changes, so a newer authoritative snapshot that finds nothing to
 * change leaves it untouched, and an older marked response then still looks
 * current and raises a card the newer one had just spoken against.
 *
 * A per conversation counter says which request is the latest regardless of
 * what either response turned out to contain.
 */
const snapshotGeneration = new Map<string, number>();

/** Claim the next snapshot generation for a conversation. */
function beginAcpSnapshot(conversationId: string | null): number {
  if (conversationId === null) {
    return 0;
  }
  const next = (snapshotGeneration.get(conversationId) ?? 0) + 1;
  snapshotGeneration.set(conversationId, next);
  return next;
}

/** Whether this response is still the newest request for its conversation. */
function isNewestAcpSnapshot(
  conversationId: string | null,
  generation: number,
): boolean {
  if (conversationId === null) {
    return true;
  }
  return (snapshotGeneration.get(conversationId) ?? 0) === generation;
}

/** Test seam: forget generations between cases. */
export function __resetAcpSnapshotGenerationsForTests(): void {
  snapshotGeneration.clear();
}

function applyAcpSnapshot(
  entries: AcpRunEntry[] | null,
  priorActiveIds: string[],
  snapshotConversationId: string | null = null,
  revisionAtFetch: number = useInteractionStore.getState().acpConnectRevision,
  generation?: number,
): void {
  if (entries === null) {
    return;
  }
  // Superseded by a later request for the same conversation. Its runs are
  // still worth seeding, but it has nothing to say about the prompt.
  const newest =
    generation === undefined ||
    isNewestAcpSnapshot(snapshotConversationId, generation);
  const store = useAcpRunStore.getState();
  if (entries.length > 0) {
    store.seedFromHistory(entries);
  }
  // Outside the length check: a conversation whose only marked run was cleared
  // can come back empty, and that emptiness is exactly the signal that the
  // prompt is stale.
  if (newest) {
    raiseAcpConnectFromSnapshot(
      entries,
      snapshotConversationId,
      revisionAtFetch,
    );
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
    // Captured before the request, like the reconnect paths. A default
    // evaluated at apply time samples the prompt a live `acp_auth_required`
    // raised while this was in flight, which is exactly the prompt the stale
    // response must not speak for.
    const revisionAtFetch = useInteractionStore.getState().acpConnectRevision;
    const generation = beginAcpSnapshot(conversationId);
    void fetchAcpSessions(assistantId, conversationId).then((entries) => {
      if (cancelled) {
        return;
      }
      applyAcpSnapshot(
        entries,
        priorActiveIds,
        conversationId ?? null,
        revisionAtFetch,
        generation,
      );
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
  // A token write on any client publishes this tag. Another client holding a
  // restored `auth_required` prompt cannot discover that on its own: the
  // prompt deliberately skips the connected-state self-heal, and nothing
  // refetches the snapshot until navigation or reconnect, so it would keep
  // offering Connect for the token that was just replaced.
  //
  // A refetch trigger and nothing more. The tag says a Claude token was
  // written, not that the failure it would retire is repaired: the write may
  // have stored a value a spawn cannot use, an api-key-shaped one or one whose
  // policy blocks the `acp_spawn` read, and the daemon goes on serving the
  // marker for exactly that reason. Retiring here would record the tool-use id
  // as dismissed before the answer arrived, and the marked snapshot that
  // follows could no longer restore the card. The snapshot itself retires the
  // prompt when it comes back unmarked, which is the authoritative answer.
  useBusSubscription("sse.event", (envelope) => {
    const message = envelope.message;
    // The config tag too: a marker is judged against the credential a spawn
    // would resolve, and for a configured
    // `acp.agents.<id>.env.CLAUDE_CODE_OAUTH_TOKEN` that is settled by config
    // rather than by a token write. Editing it repairs auth without any
    // credential write happening, so without this the card stands until
    // navigation even though the next spawn will succeed.
    if (
      message.type !== "sync_changed" ||
      !(
        message.tags?.includes(SYNC_TAGS.acpAuthRecovery) ||
        message.tags?.includes(SYNC_TAGS.assistantConfig)
      )
    ) {
      return;
    }
    if (!assistantId || !conversationId) {
      return;
    }
    const priorActiveIds = activeRunIdsFor(conversationId);
    const revisionAtFetch = useInteractionStore.getState().acpConnectRevision;
    const generation = beginAcpSnapshot(conversationId);
    void fetchAcpSessions(assistantId, conversationId).then((entries) => {
      applyAcpSnapshot(
        entries,
        priorActiveIds,
        conversationId ?? null,
        revisionAtFetch,
        generation,
      );
    });
  });

  // A Connect flow holds the prompt on its own anchor, so any auth failure
  // that arrived while it ran was turned away rather than queued. Nothing
  // replays it: the flow'''s own token write invalidates while the flow is
  // still active, so that refetch is turned away too, and the card is then
  // dismissed by the auto-continue with no fetch after it.
  //
  // Re-read once the flow settles and let the snapshot say what is true now.
  // Replaying the prompt that was turned away would be worse: the connect that
  // just completed may well have repaired it, and the snapshot knows that
  // while a remembered prompt does not.
  const flowActive = useInteractionStore.use.acpConnectFlowActive();
  const flowWasActive = useRef(false);
  useEffect(() => {
    const settled = flowWasActive.current && !flowActive;
    flowWasActive.current = flowActive;
    // Only the falling edge. Mounting with no flow running is the ordinary
    // case, and the conversation effect above already fetches for it.
    if (!settled || !assistantId || !conversationId) {
      return;
    }
    const priorActiveIds = activeRunIdsFor(conversationId);
    const revisionAtFetch = useInteractionStore.getState().acpConnectRevision;
    const generation = beginAcpSnapshot(conversationId);
    void fetchAcpSessions(assistantId, conversationId).then((entries) => {
      applyAcpSnapshot(
        entries,
        priorActiveIds,
        conversationId,
        revisionAtFetch,
        generation,
      );
    });
  }, [flowActive, assistantId, conversationId]);

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
      const revisionAtFetch = useInteractionStore.getState().acpConnectRevision;
      const generation = beginAcpSnapshot(conversationId);
      void fetchAcpSessions(assistantId, conversationId).then((entries) => {
        applyAcpSnapshot(
          entries,
          priorActiveIds,
          conversationId ?? null,
          revisionAtFetch,
          generation,
        );
      });
    },
  );
}

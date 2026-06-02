import { prepareServerMessage } from "@/domains/chat/utils/map-runtime-message";
import { segmentsToPlainText } from "@/domains/chat/utils/segments-to-plain-text";
import { liveAssistantRowId } from "@/domains/chat/hooks/stream-message-updaters";
import { dedupeDisplayMessages, mergeLatestHistoryMessage, messagesEqual } from "@/domains/chat/utils/message-merge";
import { sortByTimestamp, sortedByTimestamp, timestampToMs } from "@/domains/chat/utils/message-sorting";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { RuntimeMessage } from "@/domains/chat/api/messages";

// Re-export public types and utilities so existing consumers that import
// from `./reconcile` continue to work without changes.
export { dedupeDisplayMessages, messagesEqual } from "@/domains/chat/utils/message-merge";
export { sortByTimestamp, sortedByTimestamp, timestampToMs } from "@/domains/chat/utils/message-sorting";
export type { DisplayAttachment, DisplayMessage } from "@/domains/chat/types/types";

const STREAMING_ASSISTANT_FALLBACK_MAX_TIMESTAMP_DELTA_MS = 10 * 60 * 1000;
const STRONG_STREAMING_ASSISTANT_PREFIX_CHARS = 16;

type MessageIdentity = {
  id?: string;
  mergedMessageIds?: string[];
};

function messageIdentityKeys(message: MessageIdentity): string[] {
  return [
    ...new Set(
      [message.id, ...(message.mergedMessageIds ?? [])].filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      ),
    ),
  ];
}

function indexDisplayMessageIdentity(
  indexById: Map<string, number>,
  message: DisplayMessage,
  index: number,
): void {
  for (const id of messageIdentityKeys(message)) {
    indexById.set(id, index);
  }
}

function findDisplayMessageIndexByIdentity(
  indexById: Map<string, number>,
  message: MessageIdentity,
): number | undefined {
  for (const id of messageIdentityKeys(message)) {
    const index = indexById.get(id);
    if (index != null) return index;
  }
  return undefined;
}

function indexDisplayMessageByIdentity(
  indexById: Map<string, DisplayMessage>,
  message: DisplayMessage,
): void {
  for (const id of messageIdentityKeys(message)) {
    if (!indexById.has(id)) {
      indexById.set(id, message);
    }
  }
}

function findDisplayMessageByRuntimeIdentity(
  indexById: Map<string, DisplayMessage>,
  message: RuntimeMessage,
): DisplayMessage | undefined {
  for (const id of messageIdentityKeys(message)) {
    const existing = indexById.get(id);
    if (existing) return existing;
  }
  return undefined;
}

function hasServerIdentity(
  serverIds: Set<string>,
  message: DisplayMessage,
): boolean {
  return messageIdentityKeys(message).some((id) => serverIds.has(id));
}

function timestampsLikelySameTurn(
  currentTimestamp: number | undefined,
  incomingTimestamp: number | undefined,
): boolean {
  if (currentTimestamp == null || incomingTimestamp == null) {
    return true;
  }
  return (
    Math.abs(currentTimestamp - incomingTimestamp) <=
    STREAMING_ASSISTANT_FALLBACK_MAX_TIMESTAMP_DELTA_MS
  );
}

function streamingAssistantPrefixMatch(
  currentContent: string,
  incomingContent: string,
): { score: number; strong: boolean } | null {
  const current = currentContent.trim();
  const incoming = incomingContent.trim();
  if (!current || !incoming) {
    return null;
  }

  if (current === incoming) {
    return { score: 10_000 + current.length, strong: true };
  }

  const shorter = current.length <= incoming.length ? current : incoming;
  const longer = current.length <= incoming.length ? incoming : current;
  if (!longer.startsWith(shorter)) {
    return null;
  }

  const strong = shorter.length >= STRONG_STREAMING_ASSISTANT_PREFIX_CHARS;
  return {
    score: (strong ? 1_000 : 0) + shorter.length,
    strong,
  };
}

function selectStreamingAssistantFallbackIndex(
  candidates: Array<{ index: number; score: number; strong: boolean }>,
): number | undefined {
  if (candidates.length === 0) {
    return undefined;
  }

  const strongCandidates = candidates.filter((candidate) => candidate.strong);
  const eligible =
    strongCandidates.length > 0 ? strongCandidates : candidates;
  eligible.sort((a, b) => b.score - a.score);
  if (eligible.length === 1 || eligible[0]!.score > eligible[1]!.score) {
    return eligible[0]!.index;
  }
  return undefined;
}

/**
 * A row whose `id` is a client-generated placeholder rather than a
 * server-assigned id. Used as the signal for latest-history merge to
 * fall back to derived-text matching instead of id matching.
 */
function hasPlaceholderIdentity(message: DisplayMessage): boolean {
  return message.isOptimistic === true;
}

function findLatestHistoryFallbackIndex(
  messages: DisplayMessage[],
  incoming: DisplayMessage,
  claimedIndexes: Set<number>,
  liveRowId: string | null,
): number | undefined {
  const incomingText = segmentsToPlainText(incoming.textSegments);
  const exactIdx = messages.findIndex(
    (message, index) =>
      !claimedIndexes.has(index) &&
      hasPlaceholderIdentity(message) &&
      message.role === incoming.role &&
      segmentsToPlainText(message.textSegments) === incomingText,
  );
  if (exactIdx !== -1) {
    return exactIdx;
  }

  if (incoming.role !== "assistant") {
    return undefined;
  }

  const incomingTimestamp = timestampToMs(incoming.timestamp);
  const candidates: Array<{ index: number; score: number; strong: boolean }> = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (
      claimedIndexes.has(index) ||
      !hasPlaceholderIdentity(message) ||
      message.role !== "assistant" ||
      message.id !== liveRowId ||
      !timestampsLikelySameTurn(message.timestamp, incomingTimestamp)
    ) {
      continue;
    }

    const match = streamingAssistantPrefixMatch(
      segmentsToPlainText(message.textSegments),
      incomingText,
    );
    if (!match) {
      continue;
    }
    candidates.push({ index, ...match });
  }

  return selectStreamingAssistantFallbackIndex(candidates);
}

/**
 * Merge a freshly fetched latest-history page into messages restored from the
 * in-memory conversation cache. The cache gives a fast first paint, but it can
 * miss live-only SSE events emitted while another conversation was selected.
 */
export function reconcileDisplayMessagesWithLatestHistory(
  current: DisplayMessage[],
  latestHistory: DisplayMessage[],
  isProcessing: boolean,
): DisplayMessage[] {
  if (latestHistory.length === 0) return dedupeDisplayMessages(current);

  const liveRowId = liveAssistantRowId(current, isProcessing);
  const merged = [...current];
  const indexById = new Map<string, number>();
  const claimedIndexes = new Set<number>();
  for (let i = 0; i < merged.length; i++) {
    const message = merged[i];
    if (message) indexDisplayMessageIdentity(indexById, message, i);
  }

  for (const incoming of latestHistory) {
    let existingIdx = findDisplayMessageIndexByIdentity(indexById, incoming);
    if (existingIdx == null) {
      existingIdx = findLatestHistoryFallbackIndex(
        merged,
        incoming,
        claimedIndexes,
        liveRowId,
      );
    }

    if (existingIdx == null) {
      indexDisplayMessageIdentity(indexById, incoming, merged.length);
      merged.push(incoming);
      continue;
    }

    claimedIndexes.add(existingIdx);
    merged[existingIdx] = mergeLatestHistoryMessage(
      merged[existingIdx]!,
      incoming,
    );
    indexDisplayMessageIdentity(indexById, merged[existingIdx]!, existingIdx);
  }

  const sorted = sortedByTimestamp(dedupeDisplayMessages(merged));
  if (messagesEqual(current, sorted)) return current;
  return sorted;
}

/**
 * Reconcile locally displayed messages with the server's authoritative list.
 * Server messages are used as the source of truth for content and ordering.
 * Any local-only messages (e.g., optimistic user messages not yet on the server)
 * are appended at the end to avoid dropping them.
 *
 * Returns the original `local` array (by reference) when nothing has changed,
 * so callers can use `next === prev` to detect real changes.
 */
export function reconcileMessages(
  local: DisplayMessage[],
  server: RuntimeMessage[],
  options?: { oldestPageTimestamp?: number | null },
): DisplayMessage[] {
  if (server.length === 0) return dedupeDisplayMessages(local);

  const serverIds = new Set(server.flatMap((m) => messageIdentityKeys(m)));

  // Window boundary: use the explicit initial-page timestamp when provided
  // (stable, not widened by loadOlder). Fall back to computing from local
  // for callers that don't track the boundary.
  const oldestLocalTs = options?.oldestPageTimestamp ?? local.reduce<number | null>(
    (min, m) => m.id && m.timestamp != null && (min === null || m.timestamp < min) ? m.timestamp : min,
    null,
  );

  // Build a lookup of local messages by server-assigned id so we can preserve
  // client-side state (e.g. toolCalls accumulated from SSE events with richer
  // streaming metadata) when the server snapshot lands. Optimistic user rows
  // are skipped — their `id` is a client UUID that can't match a server id,
  // so they fall through to the tail preservation block below where a
  // content match handles the one-time id swap.
  const localById = new Map<string, DisplayMessage>();
  for (const m of local) {
    if (!m.isOptimistic) {
      indexDisplayMessageByIdentity(localById, m);
    }
  }

  const reconciled: DisplayMessage[] = server
    .filter((m) => m.role === "user" || m.role === "assistant")
    .flatMap((m) => {
      // Parse and normalize all server fields through the shared entry point.
      // This ensures content cleaning, segment normalization, and attachment
      // mapping stay in sync with history.ts — preventing the class of bug
      // where one code path forgets a transformation step.
      const prepared = prepareServerMessage(m);

      const localMsg = findDisplayMessageByRuntimeIdentity(localById, m);

      // Skip server messages that have no local match AND are older
      // than the local window. This prevents old paginated-out messages
      // from being pulled into the current view. Server messages newer
      // than the local window (e.g. from the current turn's multi-message
      // response) are kept so reconciliation can catch up.
      const serverTs = timestampToMs(m.timestamp) ?? null;
      if (!localMsg && oldestLocalTs != null && serverTs != null && serverTs < oldestLocalTs) {
        return [];
      }

      const msg: DisplayMessage = { id: m.id, role: m.role };
      if (m.mergedMessageIds?.length) msg.mergedMessageIds = m.mergedMessageIds;
      if (m.metadata) msg.metadata = m.metadata;
      if (m.subagentNotification) msg.isSubagentNotification = true;
      if (prepared.slackMessage ?? localMsg?.slackMessage) {
        msg.slackMessage = prepared.slackMessage ?? localMsg?.slackMessage;
      }

      // Prefer local toolCalls (accumulated during SSE streaming with richer
      // metadata) over the server's. When we keep local toolCalls, also keep
      // the local contentOrder, textSegments, and surfaces — they were built
      // in lockstep with those toolCalls and use matching ids. Local surfaces
      // may have been updated by ui_surface_update events that the server
      // hasn't persisted yet.
      const keepLocalToolState = !!(localMsg?.toolCalls && localMsg.toolCalls.length > 0);

      if (keepLocalToolState) {
        const localTcs = localMsg!.toolCalls!;
        // Upgrade local tool call statuses from the server when the server
        // has more-final state.  Handles missed tool_result SSE events and
        // corrects message_complete's force-completion when the server
        // actually recorded an error.  Matches by index (position) because
        // multiple calls to the same tool share a toolName.
        if (prepared.toolCalls) {
          let upgraded = false;
          const mergedToolCalls = localTcs.map((ltc, idx) => {
            const stc = prepared.toolCalls![idx];
            if (!stc) return ltc;
            const serverIsMoreFinal =
              (ltc.status === "running" && (stc.status === "completed" || stc.status === "error")) ||
              (ltc.status === "completed" && stc.status === "error");
            // Backfill result when message_complete force-completed the
            // tool call without data and the server now has the payload.
            const serverHasMissingResult =
              ltc.status === stc.status && ltc.result == null && stc.result != null;
            if (serverIsMoreFinal || serverHasMissingResult) {
              upgraded = true;
              return {
                ...ltc,
                status: stc.status,
                result: stc.result ?? ltc.result,
                isError: stc.isError ?? ltc.isError,
                completedAt: stc.completedAt ?? ltc.completedAt ?? Date.now(),
              };
            }
            return ltc;
          });
          msg.toolCalls = upgraded ? mergedToolCalls : localTcs;
        } else {
          msg.toolCalls = localTcs;
        }
        if (localMsg!.contentOrder) msg.contentOrder = localMsg!.contentOrder;
        if (localMsg!.textSegments) msg.textSegments = localMsg!.textSegments;
        if (localMsg!.surfaces) msg.surfaces = localMsg!.surfaces;
        // Keep locally-accumulated thinking deltas in lockstep with the
        // local contentOrder; fall back to the server snapshot when the
        // local row never saw any thinking SSE events.
        const localThinking = localMsg!.thinkingSegments ?? prepared.thinkingSegments;
        if (localThinking) msg.thinkingSegments = localThinking;
      } else {
        // Prefer local surfaces (updated by SSE ui_surface_update events)
        // over server surfaces which may be stale.
        if (localMsg?.surfaces != null) {
          msg.surfaces = localMsg.surfaces;
        } else if (m.surfaces) {
          msg.surfaces = m.surfaces;
        }
        if (prepared.toolCalls) {
          const serverToolCalls = [...prepared.toolCalls];
          // Monotonic: never downgrade tool call status from completed/error
          // back to running. The local state from SSE events is more current
          // than the server's periodic snapshot.
          if (localMsg?.toolCalls) {
            for (const stc of serverToolCalls) {
              const localTc = localMsg.toolCalls.find((ltc) => ltc.id === stc.id);
              if (
                localTc &&
                (localTc.status === "completed" || localTc.status === "error") &&
                stc.status === "running"
              ) {
                stc.status = localTc.status;
                stc.result = localTc.result;
                stc.isError = localTc.isError;
              }
            }
          }
          msg.toolCalls = serverToolCalls;
        }
        if (prepared.normalizedContentOrder) msg.contentOrder = prepared.normalizedContentOrder;
        if (prepared.normalizedSegments) msg.textSegments = prepared.normalizedSegments;
        // Prefer locally-accumulated thinking deltas (richer, in-progress)
        // over the server snapshot, which may lag the live stream.
        const thinking = localMsg?.thinkingSegments ?? prepared.thinkingSegments;
        if (thinking) msg.thinkingSegments = thinking;
      }

      // Use server timestamp when available, otherwise preserve client-side one.
      if (prepared.timestamp != null) {
        msg.timestamp = prepared.timestamp;
      } else if (localMsg?.timestamp) {
        msg.timestamp = localMsg.timestamp;
      }

      // Prefer local attachments that carry client-side blob URLs over
      // server metadata. However, if all local attachments are synthetic
      // "rehydrated:N" stubs (from text-parsing fallback), prefer server
      // structured metadata when available — those carry real daemon UUIDs
      // that resolve against the content endpoint.
      const localAtts = localMsg?.attachments;
      const hasRealLocalAtts = localAtts && localAtts.length > 0 &&
        !localAtts.every((a) => a.id.startsWith("rehydrated:"));
      if (hasRealLocalAtts) {
        msg.attachments = localAtts;
      } else if (prepared.structuredAttachments) {
        msg.attachments = prepared.structuredAttachments;
      } else if (localAtts && localAtts.length > 0) {
        msg.attachments = localAtts;
      } else if (prepared.parsedAttachments) {
        msg.attachments = prepared.parsedAttachments;
      }

      return [msg];
    });

  // Preserve any local messages not yet reflected on the server. Two
  // shapes survive into here:
  //
  //  1. Optimistic user rows (`isOptimistic === true`) — their `id` is a
  //     client UUID, never in `serverIds`. We try a content match against
  //     the reconciled array; if a server row matches, transfer the
  //     client-side timestamp/attachments to it (the optimistic row is
  //     dropped, the server row takes over). Otherwise preserve the
  //     optimistic row as-is so the user's message doesn't vanish
  //     between POST and the server's first snapshot.
  //
  //  2. Non-optimistic local rows whose id isn't in `serverIds` — likely
  //     brief replication lag or pagination. Preserve to prevent
  //     vanishing.
  for (const m of local) {
    if (!m.isOptimistic && hasServerIdentity(serverIds, m)) continue;

    if (m.isOptimistic && m.role === "user") {
      // Tail content-match swap: the queued send path keeps the user row
      // optimistic until a server snapshot echoes back its content with
      // a freshly minted server id. When that lands, drop the optimistic
      // row in favor of the server-derived row, but transfer client-side
      // state that the server snapshot doesn't carry (timestamp, and
      // crucially blob-URL attachments for in-browser preview).
      const optimisticText = segmentsToPlainText(m.textSegments);
      const match = reconciled.find(
        (r) =>
          r.role === "user" &&
          segmentsToPlainText(r.textSegments) === optimisticText,
      );
      if (match) {
        if (!match.timestamp && m.timestamp) {
          match.timestamp = m.timestamp;
        }
        // Local attachments win over server: the local row holds the
        // blob preview URL the user is actively viewing; server
        // attachments only carry backend UUIDs which may 404 until the
        // upload finalizes.
        if (m.attachments && m.attachments.length > 0) {
          match.attachments = m.attachments;
        }
      } else {
        reconciled.push(m);
      }
    } else {
      reconciled.push(m);
    }
  }

  sortByTimestamp(reconciled);

  const deduped = dedupeDisplayMessages(reconciled);

  // Return the original array when nothing changed so that callers using
  // reference equality (next !== prev) correctly detect stability.
  if (messagesEqual(local, deduped)) return local;

  return deduped;
}

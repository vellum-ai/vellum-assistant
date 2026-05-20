import { prepareServerMessage } from "@/domains/chat/utils/map-runtime-message.js";
import { dedupeDisplayMessages, mergeLatestHistoryMessage, messagesEqual } from "@/domains/chat/utils/message-merge.js";
import { sortByTimestamp, sortedByTimestamp, timestampToMs } from "@/domains/chat/utils/message-sorting.js";
import { newStableId } from "@/domains/chat/utils/stable-id.js";
import type { DisplayMessage } from "@/domains/chat/lib/types.js";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types.js";
import type { RuntimeMessage } from "@/domains/chat/api/messages.js";

// Re-export public types and utilities so existing consumers that import
// from `./reconcile` continue to work without changes.
export { dedupeDisplayMessages, messagesEqual } from "@/domains/chat/utils/message-merge.js";
export { sortByTimestamp, sortedByTimestamp, timestampToMs } from "@/domains/chat/utils/message-sorting.js";
export type { DisplayAttachment, DisplayMessage } from "@/domains/chat/lib/types.js";

const STREAMING_ASSISTANT_FALLBACK_MAX_TIMESTAMP_DELTA_MS = 10 * 60 * 1000;
const STRONG_STREAMING_ASSISTANT_PREFIX_CHARS = 16;

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

function findLatestHistoryFallbackIndex(
  messages: DisplayMessage[],
  incoming: DisplayMessage,
  claimedIndexes: Set<number>,
): number | undefined {
  const exactIdx = messages.findIndex(
    (message, index) =>
      !claimedIndexes.has(index) &&
      !message.id &&
      message.role === incoming.role &&
      message.content === incoming.content,
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
      message.id ||
      message.role !== "assistant" ||
      !message.isStreaming ||
      !timestampsLikelySameTurn(message.timestamp, incomingTimestamp)
    ) {
      continue;
    }

    const match = streamingAssistantPrefixMatch(
      message.content,
      incoming.content,
    );
    if (!match) {
      continue;
    }
    candidates.push({ index, ...match });
  }

  return selectStreamingAssistantFallbackIndex(candidates);
}

function findRuntimeFallbackMessage(
  local: DisplayMessage[],
  serverMessage: RuntimeMessage,
  claimedLocal: Set<DisplayMessage>,
): DisplayMessage | undefined {
  const exact = local.find(
    (localMessage) =>
      !claimedLocal.has(localMessage) &&
      localMessage.role === serverMessage.role &&
      localMessage.content === serverMessage.content,
  );
  if (exact) {
    return exact;
  }

  if (serverMessage.role !== "assistant") {
    return undefined;
  }

  const incomingTimestamp = timestampToMs(serverMessage.timestamp);
  const candidates: Array<{ index: number; score: number; strong: boolean }> = [];
  for (let index = 0; index < local.length; index++) {
    const localMessage = local[index]!;
    if (
      claimedLocal.has(localMessage) ||
      localMessage.id ||
      localMessage.role !== "assistant" ||
      !localMessage.isStreaming ||
      !timestampsLikelySameTurn(localMessage.timestamp, incomingTimestamp)
    ) {
      continue;
    }

    const match = streamingAssistantPrefixMatch(
      localMessage.content,
      serverMessage.content,
    );
    if (!match) {
      continue;
    }
    candidates.push({ index, ...match });
  }

  const selectedIndex = selectStreamingAssistantFallbackIndex(candidates);
  return selectedIndex == null ? undefined : local[selectedIndex];
}

/**
 * Merge a freshly fetched latest-history page into messages restored from the
 * in-memory conversation cache. The cache gives a fast first paint, but it can
 * miss live-only SSE events emitted while another conversation was selected.
 */
export function reconcileDisplayMessagesWithLatestHistory(
  current: DisplayMessage[],
  latestHistory: DisplayMessage[],
): DisplayMessage[] {
  if (latestHistory.length === 0) return dedupeDisplayMessages(current);

  const merged = [...current];
  const indexById = new Map<string, number>();
  const claimedIndexes = new Set<number>();
  for (let i = 0; i < merged.length; i++) {
    const id = merged[i]?.id;
    if (id) indexById.set(id, i);
  }

  for (const incoming of latestHistory) {
    let existingIdx = incoming.id ? indexById.get(incoming.id) : undefined;
    if (existingIdx == null) {
      existingIdx = findLatestHistoryFallbackIndex(
        merged,
        incoming,
        claimedIndexes,
      );
    }

    if (existingIdx == null) {
      if (incoming.id) indexById.set(incoming.id, merged.length);
      merged.push(incoming);
      continue;
    }

    claimedIndexes.add(existingIdx);
    merged[existingIdx] = mergeLatestHistoryMessage(
      merged[existingIdx]!,
      incoming,
    );
    if (incoming.id) indexById.set(incoming.id, existingIdx);
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

  const serverIds = new Set(server.map((m) => m.id));

  // Window boundary: use the explicit initial-page timestamp when provided
  // (stable, not widened by loadOlder). Fall back to computing from local
  // for callers that don't track the boundary.
  const oldestLocalTs = options?.oldestPageTimestamp ?? local.reduce<number | null>(
    (min, m) => m.id && m.timestamp != null && (min === null || m.timestamp < min) ? m.timestamp : min,
    null,
  );

  // Build lookups of local messages by display id and concrete daemon row id so
  // we can preserve client-side state (e.g. toolCalls accumulated from SSE
  // events with richer streaming metadata). During reconnect/background gaps,
  // history may return the merged display id before message_complete rewrites
  // the local streamed row away from the concrete row id.
  const localById = new Map<string, DisplayMessage>();
  const localByDaemonMessageId = new Map<string, DisplayMessage>();
  // Track which local messages have already been matched to a server row so
  // the fallback match (role + content + timestamp) used for optimistic rows
  // can't steal a local row that's already been claimed by the id lookup.
  const claimedLocal = new Set<DisplayMessage>();
  for (const m of local) {
    if (m.id) {
      localById.set(m.id, m);
    }
    if (m.daemonMessageId) {
      localByDaemonMessageId.set(m.daemonMessageId, m);
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

      let localMsg = localById.get(m.id);
      if (!localMsg && m.daemonMessageId) {
        localMsg =
          localByDaemonMessageId.get(m.daemonMessageId) ??
          localById.get(m.daemonMessageId);
      }
      if (localMsg) {
        claimedLocal.add(localMsg);
      } else {
        // Fallback: optimistic/no-id rows can be assigned a server id after
        // the client has already rendered them. For user messages, exact
        // role/content is sufficient. For assistant messages, the local row
        // may only contain a streaming prefix while the history row contains
        // the final text, so use a conservative prefix + timestamp match.
        // Use cleanedContent so the comparison matches the local row's clean text.
        const fallback = findRuntimeFallbackMessage(
          local,
          prepared.cleanedContent !== m.content ? { ...m, content: prepared.cleanedContent } : m,
          claimedLocal,
        );
        if (fallback) {
          localMsg = fallback;
          claimedLocal.add(fallback);
        }
      }

      // Skip server messages that have no local match AND are older
      // than the local window. This prevents old paginated-out messages
      // from being pulled into the current view. Server messages newer
      // than the local window (e.g. from the current turn's multi-message
      // response) are kept so reconciliation can catch up.
      const serverTs = timestampToMs(m.timestamp) ?? null;
      if (!localMsg && oldestLocalTs != null && serverTs != null && serverTs < oldestLocalTs) {
        return [];
      }

      const stableId = localMsg?.stableId ?? newStableId("server");

      const msg: DisplayMessage = { stableId, id: m.id, role: m.role, content: prepared.cleanedContent };
      if (m.daemonMessageId || localMsg?.daemonMessageId) {
        msg.daemonMessageId = m.daemonMessageId ?? localMsg?.daemonMessageId;
      }
      if (m.metadata) msg.metadata = m.metadata;
      if (m.subagentNotification) msg.isSubagentNotification = true;

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

  // Safety net for SSE-accumulated toolCalls that weren't matched above.
  // The primary id-based lookup may fail when the SSE event messageId differs
  // from the server API's message id, or when the message had no id yet.
  // Collect all toolCall groups from local that are NOT present in the
  // reconciled array and re-attach them by matching assistant messages in order.
  const reconciledToolCallIds = new Set<string>();
  for (const msg of reconciled) {
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        reconciledToolCallIds.add(tc.id);
      }
    }
  }

  // Each lost group tracks toolCalls AND the contentOrder/textSegments from
  // the local message that owned them, so reattachment preserves interleaving.
  interface LostToolGroup {
    toolCalls: ChatMessageToolCall[];
    contentOrder?: DisplayMessage["contentOrder"];
    textSegments?: DisplayMessage["textSegments"];
    content: string;
  }
  const lostToolCallGroups: LostToolGroup[] = [];
  for (const m of local) {
    if (m.role !== "assistant" || !m.toolCalls || m.toolCalls.length === 0) continue;
    // Skip messages that will be preserved whole by the else branch below —
    // their tool calls don't need rescuing onto another message.
    if (!claimedLocal.has(m) && !(m.id && serverIds.has(m.id))) continue;
    // Check if this group's tool calls are already on a reconciled message
    const firstTc = m.toolCalls[0];
    if (firstTc && !reconciledToolCallIds.has(firstTc.id)) {
      lostToolCallGroups.push({
        toolCalls: m.toolCalls,
        contentOrder: m.contentOrder,
        textSegments: m.textSegments,
        content: m.content,
      });
    }
  }

  if (lostToolCallGroups.length > 0) {
    // Try to match each lost group to the best reconciled assistant message:
    // 1. Same content as the local message that owned the group
    // 2. Failing that, assign in order to assistant messages without toolCalls
    let lostIdx = 0;

    const applyLostGroup = (msg: DisplayMessage, group: LostToolGroup): DisplayMessage => ({
      ...msg,
      toolCalls: group.toolCalls,
      ...(group.contentOrder ? { contentOrder: group.contentOrder } : {}),
      ...(group.textSegments ? { textSegments: group.textSegments } : {}),
    });

    for (let i = 0; i < reconciled.length && lostIdx < lostToolCallGroups.length; i++) {
      const msg = reconciled[i];
      if (!msg || msg.role !== "assistant" || (msg.toolCalls && msg.toolCalls.length > 0)) continue;

      // Check if this reconciled message's content matches the local message
      // that owned the lost group, OR if we've run out of better matches
      const localOwner = lostToolCallGroups[lostIdx];
      const contentMatch = localOwner && (
        msg.content === localOwner.content ||
        localOwner.content === "" ||
        (localOwner.content.length > 0 && msg.content.includes(localOwner.content))
      );

      if (contentMatch) {
        reconciled[i] = applyLostGroup(msg, lostToolCallGroups[lostIdx]!);
        lostIdx++;
      }
    }

    // If content matching didn't place all groups, assign remaining to the
    // last assistant message(s) without toolCalls (most recent turn).
    if (lostIdx < lostToolCallGroups.length) {
      for (let i = reconciled.length - 1; i >= 0 && lostIdx < lostToolCallGroups.length; i--) {
        const msg = reconciled[i];
        if (msg && msg.role === "assistant" && (!msg.toolCalls || msg.toolCalls.length === 0)) {
          reconciled[i] = applyLostGroup(msg, lostToolCallGroups[lostIdx]!);
          lostIdx++;
        }
      }
    }
  }

  // Preserve any local messages not yet reflected on the server
  for (const m of local) {
    if (m.id && serverIds.has(m.id)) continue;
    if (claimedLocal.has(m)) continue;
    if (!m.id && m.role === "user") {
      // Optimistic user message — keep if no server message has same content
      const alreadyOnServer = reconciled.some(
        (r) => r.role === "user" && r.content === m.content,
      );
      if (alreadyOnServer) {
        // Transfer client-side state (timestamp, attachments) to the matching
        // reconciled message so the data doesn't vanish when the server
        // confirms the message.
        const match = reconciled.find(
          (r) =>
            r.role === "user" &&
            r.content === m.content &&
            (!r.timestamp || !r.attachments),
        );
        if (match) {
          if (!match.timestamp && m.timestamp) {
            match.timestamp = m.timestamp;
          }
          if (!match.attachments && m.attachments && m.attachments.length > 0) {
            match.attachments = m.attachments;
          }
        }
      } else {
        reconciled.push({ ...m, isStreaming: false });
      }
    } else {
      // Message received via SSE (with or without a server-assigned id) that
      // the history endpoint didn't return — likely due to brief replication
      // lag or pagination limits. Preserve it to prevent it from vanishing.
      reconciled.push({ ...m, isStreaming: false });
    }
  }

  sortByTimestamp(reconciled);

  // Safety net: deduplicate by both server id and stableId. Server id
  // dedup catches duplicate SSE/history rows. StableId dedup catches rare
  // fallback matches that reused the same React row key for two entries.
  const deduped = dedupeDisplayMessages(reconciled);

  // Return the original array when nothing changed so that callers using
  // reference equality (next !== prev) correctly detect stability.
  if (messagesEqual(local, deduped)) return local;

  return deduped;
}

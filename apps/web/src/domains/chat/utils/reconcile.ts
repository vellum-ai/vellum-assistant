import { segmentsToPlainText } from "@/domains/chat/utils/segments-to-plain-text";
import { liveAssistantRowId } from "@/domains/chat/utils/stream-updaters/shared";
import { dedupeDisplayMessages, mergeLatestHistoryMessage, messagesEqual } from "@/domains/chat/utils/message-merge";
import { messageIdentityKeys } from "@/domains/chat/utils/message-identity";
import { sortedByTimestamp, timestampToMs } from "@/domains/chat/utils/message-sorting";
import type { DisplayMessage } from "@/domains/chat/types/types";

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

// Index-based identity lookup, used only by the latest-history merge below
// (which tracks positions in a working array). The object-based variants live
// in `message-identity.ts`.
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

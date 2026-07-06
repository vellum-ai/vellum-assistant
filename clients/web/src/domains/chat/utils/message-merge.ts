import type { DisplayMessage } from "@/domains/chat/types/types";

export function messagesEqual(
  a: DisplayMessage[],
  b: DisplayMessage[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const am = a[i]!;
    const bm = b[i]!;
    if (
      am.id !== bm.id ||
      am.role !== bm.role ||
      am.timestamp !== bm.timestamp ||
      JSON.stringify(am.mergedMessageIds) !==
        JSON.stringify(bm.mergedMessageIds) ||
      JSON.stringify(am.contentBlocks) !== JSON.stringify(bm.contentBlocks) ||
      JSON.stringify(am.surfaces) !== JSON.stringify(bm.surfaces) ||
      JSON.stringify(am.textSegments) !== JSON.stringify(bm.textSegments) ||
      JSON.stringify(am.contentOrder) !== JSON.stringify(bm.contentOrder) ||
      JSON.stringify(am.thinkingSegments) !==
        JSON.stringify(bm.thinkingSegments) ||
      JSON.stringify(am.slackMessage) !== JSON.stringify(bm.slackMessage) ||
      JSON.stringify(am.toolCalls) !== JSON.stringify(bm.toolCalls) ||
      JSON.stringify(am.attachments) !== JSON.stringify(bm.attachments)
    ) {
      return false;
    }

    // Compare any arbitrary passthrough fields beyond the known set
    const knownKeys = new Set([
      "id",
      "mergedMessageIds",
      "role",
      "contentBlocks",
      "surfaces",
      "textSegments",
      "contentOrder",
      "thinkingSegments",
      "slackMessage",
      "toolCalls",
      "attachments",
      "timestamp",
      "queueStatus",
      "queuePosition",
    ]);
    const amKeys = Object.keys(am).filter((k) => !knownKeys.has(k));
    const bmKeys = Object.keys(bm).filter((k) => !knownKeys.has(k));
    if (amKeys.length !== bmKeys.length) return false;
    for (const key of new Set([...amKeys, ...bmKeys])) {
      if (
        JSON.stringify((am as unknown as Record<string, unknown>)[key]) !==
        JSON.stringify((bm as unknown as Record<string, unknown>)[key])
      )
        return false;
    }
  }
  return true;
}

function mergeStringArrays(
  current: string[] | undefined,
  incoming: string[] | undefined,
): string[] | undefined {
  const merged = [...new Set([...(current ?? []), ...(incoming ?? [])])];
  return merged.length > 0 ? merged : undefined;
}

/**
 * Concatenate two arrays, returning whichever side is populated when the
 * other is empty / undefined. Used by the adjacent-assistant fold to avoid
 * materialising `[...undefined, ...x]` and stripping the undefined slot in
 * the spread output.
 */
function concatOptionalArrays<T>(
  current: T[] | undefined,
  incoming: T[] | undefined,
): T[] | undefined {
  if (!current || current.length === 0) return incoming;
  if (!incoming || incoming.length === 0) return current;
  return [...current, ...incoming];
}

/**
 * Remap a paginated assistant message's `contentOrder` entries when the
 * message is being folded onto an older sibling.
 *
 * History payloads from the server reference array members by *position*
 * — `{ type: "text", id: "0" }`, `{ type: "attachment", id: "2" }`,
 * `{ type: "tool", id: "1" }`, `{ type: "surface", id: "0" }`.
 * `normalizeContentBlocks` (api/messages.ts) walks `contentOrder` and
 * resolves each numeric id via `parseInt(id, 10) → array[idx]` to
 * synthesize a `contentBlocks` projection for rows the server sent
 * without one. When we concatenate the donor's `textSegments` /
 * `attachments` / `toolCalls` / `surfaces` onto the survivor's, every
 * *positional* numeric reference in the donor's contentOrder must shift
 * by the survivor's array length so it still resolves to the right
 * member in the merged arrays.
 *
 * Streaming-shape entries carry real ids instead (text-segment object
 * `id`s, tool-use ids like `toolu_…`, surface UUIDs); those are not
 * positional and must pass through untouched. The `/^\d+$/` gate
 * distinguishes positional numeric ids ("0", "12") from real ids
 * ("toolu_abc", "surf-uuid", "seg-3").
 */
function remapAdjacentContentOrder(
  entries: Array<{ type: string; id: string }> | undefined,
  offsets: {
    text: number;
    attachment: number;
    toolCall: number;
    surface: number;
    thinking: number;
  },
): Array<{ type: string; id: string }> | undefined {
  if (!entries || entries.length === 0) return entries;
  if (
    offsets.text === 0 &&
    offsets.attachment === 0 &&
    offsets.toolCall === 0 &&
    offsets.surface === 0 &&
    offsets.thinking === 0
  ) {
    return entries;
  }
  return entries.map((entry) => {
    const offset = pickContentOrderOffset(entry.type, offsets);
    if (offset === 0) return entry;
    // Real ids (UUIDs, tool-use ids, surfaceIds, segment ids) resolve via
    // the renderer's id-keyed lookup — leave them alone. Only positional
    // numeric ids ("0", "1", "12") hit the parseInt fallback that needs
    // shifting after the survivor's array members claim 0..N-1.
    if (!/^\d+$/.test(entry.id)) return entry;
    const idx = parseInt(entry.id, 10);
    return { ...entry, id: String(idx + offset) };
  });
}

function pickContentOrderOffset(
  entryType: string,
  offsets: {
    text: number;
    attachment: number;
    toolCall: number;
    surface: number;
    thinking: number;
  },
): number {
  if (entryType === "text") return offsets.text;
  if (entryType === "attachment") return offsets.attachment;
  // Streaming pipeline writes "toolCall"; history pipeline writes "tool"
  // — `transcript-message-body.tsx` treats them as the same entry kind.
  if (entryType === "tool" || entryType === "toolCall") return offsets.toolCall;
  if (entryType === "surface") return offsets.surface;
  if (entryType === "thinking") return offsets.thinking;
  return 0;
}

function canFoldAdjacentAssistant(
  survivor: DisplayMessage,
  donor: DisplayMessage,
): boolean {
  if (survivor.role !== "assistant" || donor.role !== "assistant") return false;
  // Optimistic ids are client UUIDs not yet echoed by the server; the
  // snapshot reconcile's optimistic echo-swap needs them to stay
  // standalone until the server snapshot lands.
  if (survivor.isOptimistic || donor.isOptimistic) return false;
  // Subagent / ACP notification rows are state-reconstruction metadata that
  // `build-items.ts` filters out of the rendered transcript — folding
  // them into a real assistant turn would either lose the flag or
  // suppress the merged turn entirely.
  if (
    survivor.isSubagentNotification ||
    donor.isSubagentNotification ||
    survivor.isAcpNotification ||
    donor.isAcpNotification ||
    survivor.isBackgroundEventNotification ||
    donor.isBackgroundEventNotification
  ) {
    return false;
  }
  return true;
}

function foldAdjacentAssistant(
  survivor: DisplayMessage,
  donor: DisplayMessage,
): DisplayMessage {
  const offsets = {
    text: survivor.textSegments?.length ?? 0,
    attachment: survivor.attachments?.length ?? 0,
    toolCall: survivor.toolCalls?.length ?? 0,
    surface: survivor.surfaces?.length ?? 0,
    thinking: survivor.thinkingSegments?.length ?? 0,
  };

  const textSegments = concatOptionalArrays(
    survivor.textSegments,
    donor.textSegments,
  );
  const remappedDonorContentOrder = remapAdjacentContentOrder(
    donor.contentOrder,
    offsets,
  );
  const contentOrder = concatOptionalArrays(
    survivor.contentOrder,
    remappedDonorContentOrder,
  );
  // toolCalls + surfaces concat — their contentOrder references are
  // either id-keyed (streaming-shape, e.g. "toolu_abc") or positional
  // (history-shape, e.g. "0"). Positional ids are shifted above by
  // `remapAdjacentContentOrder` so they continue to index the right
  // member of the concatenated array.
  const toolCalls = concatOptionalArrays(survivor.toolCalls, donor.toolCalls);
  const surfaces = concatOptionalArrays(survivor.surfaces, donor.surfaces);
  const attachments = concatOptionalArrays(
    survivor.attachments,
    donor.attachments,
  );
  const thinkingSegments = concatOptionalArrays(
    survivor.thinkingSegments,
    donor.thinkingSegments,
  );
  // Concatenate the unified block projections in the same survivor→donor order
  // as the positional arrays. Blocks embed their full referents (no positional
  // ids), so unlike `contentOrder` they need no offset remap — the donor's
  // blocks simply append after the survivor's. Every row reaching the fold has
  // been normalized (`normalizeContentBlocks`), so its blocks already span its
  // own `thinkingSegments`; concatenating two such rows keeps the merged row in
  // lockstep, and the block-first reader resolves each thinking index from the
  // right side.
  const contentBlocks = survivor.contentBlocks
    ? [...survivor.contentBlocks, ...(donor.contentBlocks ?? [])]
    : donor.contentBlocks;

  // Donor's id becomes a merged alias on the survivor so subsequent
  // reconcile / SSE lookups by donor id still resolve to the survivor.
  const mergedMessageIds = mergeStringArrays(
    survivor.mergedMessageIds,
    [donor.id, ...(donor.mergedMessageIds ?? [])].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    ),
  );

  const merged: DisplayMessage = {
    ...survivor,
  };
  if (textSegments) merged.textSegments = textSegments;
  if (contentOrder) merged.contentOrder = contentOrder;
  if (toolCalls) merged.toolCalls = toolCalls;
  if (surfaces) merged.surfaces = surfaces;
  if (attachments) merged.attachments = attachments;
  if (thinkingSegments) merged.thinkingSegments = thinkingSegments;
  if (contentBlocks) merged.contentBlocks = contentBlocks;
  if (mergedMessageIds) merged.mergedMessageIds = mergedMessageIds;
  // metadata / slackMessage / timestamp come from the survivor (older
  // anchor) via the spread — matches the backend's
  // `mergeConsecutiveAssistantMessages` which keeps the anchor's
  // metadata, createdAt, and id.
  return merged;
}

/**
 * Fold runs of adjacent `role: "assistant"` rows onto the first row of
 * each run, mirroring the backend's
 * `mergeConsecutiveAssistantMessages` so a single logical assistant turn
 * shows up as one client object regardless of how pagination split it.
 *
 * The backend's read-side merge only sees rows within one paginated
 * page. When a long turn spans N pages, the backend produces N display
 * messages — each anchored on its page's oldest assistant row — and the
 * client's id-keyed reconciler can't merge them because the anchors
 * have distinct ids. Walking adjacency once on the client closes that
 * gap: identical to what the backend would have produced if it had all
 * the rows in one query.
 *
 * Skipped (conservatively) for optimistic / subagent-notification rows —
 * see `canFoldAdjacentAssistant` for why.
 *
 * Returns the input array unchanged when no run exists, so referential
 * equality short-circuits downstream memos.
 */
export function mergeAdjacentAssistantMessages(
  messages: DisplayMessage[],
): DisplayMessage[] {
  let firstFoldIdx = -1;
  for (let i = 1; i < messages.length; i++) {
    if (canFoldAdjacentAssistant(messages[i - 1]!, messages[i]!)) {
      firstFoldIdx = i;
      break;
    }
  }
  if (firstFoldIdx === -1) return messages;

  const result: DisplayMessage[] = messages.slice(0, firstFoldIdx);
  for (let i = firstFoldIdx; i < messages.length; i++) {
    const msg = messages[i]!;
    const survivor = result[result.length - 1];
    if (survivor && canFoldAdjacentAssistant(survivor, msg)) {
      result[result.length - 1] = foldAdjacentAssistant(survivor, msg);
    } else {
      result.push(msg);
    }
  }
  return result;
}

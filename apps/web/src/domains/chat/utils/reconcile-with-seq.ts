import { mapRuntimeToDisplayMessage } from "@/domains/chat/utils/map-runtime-message";
import {
  dedupeDisplayMessages,
  messagesEqual,
} from "@/domains/chat/utils/message-merge";
import {
  findDisplayMessageByRuntimeIdentity,
  hasServerIdentity,
  indexDisplayMessageByIdentity,
  messageIdentityKeys,
} from "@/domains/chat/utils/message-identity";
import {
  sortByTimestamp,
  timestampToMs,
} from "@/domains/chat/utils/message-sorting";
import { segmentsToPlainText } from "@/domains/chat/utils/segments-to-plain-text";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { ConversationMessage } from "@vellumai/assistant-api";

/**
 * Seq-aware snapshot/stream reconciler (the ATL-781 monotonic merge).
 *
 * `/messages` persistence is debounced, so a refetched snapshot can carry a
 * watermark `S` (how far the daemon had persisted) that sits *behind* content
 * the live stream already rendered. The legacy reconciler had no seq
 * awareness and guarded regression with content heuristics; a plain-text
 * assistant turn slipped through and a stale snapshot truncated the rendered
 * answer.
 *
 * This reconciler replaces those heuristics with one CDC-style invariant,
 * comparing two per-conversation numbers:
 *   - `S` = the snapshot watermark (`snapshot-seq.ts`, recorded from the
 *     top-level `seq` on `/messages`).
 *   - `F` = the applied frontier the live stream has carried this conversation
 *     to (`applied-seq.ts`, advanced by the SSE consumer).
 *
 * When `F > S` the snapshot is stale: every row it carries reflects state at
 * or below `S`, so applying it would regress rows the stream advanced past
 * `S`. We keep the live local rows. When `S >= F` (or either is unknown) the
 * snapshot has seen everything the stream applied, so it is authoritative and
 * we take the server rows wholesale.
 *
 * Idempotent stream apply (events with `seq <= F` are no-ops) is enforced
 * upstream in the SSE consumer, so this merge never has to dedupe replays.
 *
 * Gated behind `isSeqGapDetectionEnabled()`. While the flag is off, callers
 * use the legacy `reconcileMessages`; this module is the only path when it is
 * on, and the legacy one is removed when the flag graduates.
 */
export interface ReconcileWithSeqOptions {
  /** Snapshot watermark `S` — how far `/messages` had persisted. */
  snapshotSeq: number | null;
  /** Applied frontier `F` — how far the stream has carried this conversation. */
  appliedSeq: number | null;
  /**
   * Stable oldest-page timestamp boundary. Server rows with no local match
   * and a timestamp older than this are paginated-out history and dropped, so
   * a snapshot can't pull old messages back into the current window.
   */
  oldestPageTimestamp?: number | null;
}

/**
 * Merge a `/messages` snapshot into the local transcript under the monotonic
 * watermark rule above. Returns the original `local` array unchanged when the
 * merge is a no-op, so callers relying on reference equality detect stability.
 */
export function reconcileMessagesWithSeq(
  local: DisplayMessage[],
  server: ConversationMessage[],
  options: ReconcileWithSeqOptions,
): DisplayMessage[] {
  if (server.length === 0) {
    return dedupeDisplayMessages(local);
  }

  const streamAhead =
    options.snapshotSeq != null &&
    options.appliedSeq != null &&
    options.snapshotSeq < options.appliedSeq;

  const serverIds = new Set(server.flatMap((m) => messageIdentityKeys(m)));

  const oldestLocalTs =
    options.oldestPageTimestamp ??
    local.reduce<number | null>(
      (min, m) =>
        m.id && m.timestamp != null && (min === null || m.timestamp < min)
          ? m.timestamp
          : min,
      null,
    );

  // Index local rows by every server-assigned identity key. Optimistic user
  // rows are skipped — their `id` is a client UUID that can't match a server
  // id, so they fall through to the tail block for the content-match swap.
  const localById = new Map<string, DisplayMessage>();
  for (const m of local) {
    if (!m.isOptimistic) {
      indexDisplayMessageByIdentity(localById, m);
    }
  }

  const reconciled: DisplayMessage[] = server
    .filter((m) => m.role === "user" || m.role === "assistant")
    .flatMap((m) => {
      const localMsg = findDisplayMessageByRuntimeIdentity(localById, m);

      const serverTs = timestampToMs(m.timestamp) ?? null;
      if (
        !localMsg &&
        oldestLocalTs != null &&
        serverTs != null &&
        serverTs < oldestLocalTs
      ) {
        return [];
      }

      if (streamAhead && localMsg) {
        // Stale snapshot, live local row: keep the streamed row and adopt
        // only the server-assigned identity so dedupe and the optimistic
        // echo-swap still resolve the row to its canonical id.
        return [adoptServerIdentity(localMsg, m)];
      }

      // Authoritative snapshot, or a server row with no live local copy: take
      // the server row wholesale, carrying only the client-only blob
      // attachments the snapshot cannot represent.
      return [
        preserveClientAttachments(mapRuntimeToDisplayMessage(m), localMsg),
      ];
    });

  preserveUnreflectedLocalRows(reconciled, local, serverIds);

  sortByTimestamp(reconciled);

  const deduped = dedupeDisplayMessages(reconciled);
  if (messagesEqual(local, deduped)) {
    return local;
  }
  return deduped;
}

/**
 * Keep a live local row but stamp the server-assigned identity onto it: adopt
 * the server `id`, fold the previous local id into `mergedMessageIds`, and
 * only borrow the server timestamp when the row has none yet.
 */
function adoptServerIdentity(
  localMsg: DisplayMessage,
  server: ConversationMessage,
): DisplayMessage {
  const next: DisplayMessage = { ...localMsg, id: server.id };

  const merged = new Set([
    ...(localMsg.mergedMessageIds ?? []),
    ...(server.mergedMessageIds ?? []),
  ]);
  if (localMsg.id && localMsg.id !== server.id) {
    merged.add(localMsg.id);
  }
  merged.delete(server.id);
  if (merged.size > 0) {
    next.mergedMessageIds = [...merged];
  }

  if (localMsg.timestamp == null) {
    const serverTs = timestampToMs(server.timestamp);
    if (serverTs != null) {
      next.timestamp = serverTs;
    }
  }

  return next;
}

/**
 * Prefer client-side blob-URL attachments over the snapshot's metadata: the
 * local row holds the preview URL the user is actively viewing, while server
 * attachments only carry backend UUIDs. Synthetic `rehydrated:` stubs (from
 * the text-parsing fallback) lose to the snapshot's real metadata.
 */
function preserveClientAttachments(
  serverRow: DisplayMessage,
  localMsg: DisplayMessage | undefined,
): DisplayMessage {
  const localAtts = localMsg?.attachments;
  const hasRealLocalAtts =
    !!localAtts &&
    localAtts.length > 0 &&
    !localAtts.every((a) => a.id.startsWith("rehydrated:"));
  if (hasRealLocalAtts) {
    return { ...serverRow, attachments: localAtts };
  }
  if (serverRow.attachments && serverRow.attachments.length > 0) {
    return serverRow;
  }
  if (localAtts && localAtts.length > 0) {
    return { ...serverRow, attachments: localAtts };
  }
  return serverRow;
}

/**
 * Append local rows not yet reflected on the server so they don't vanish:
 *   1. Optimistic user rows (client UUID, never in `serverIds`) — matched by
 *      content to a reconciled server row; on a hit the client timestamp and
 *      blob attachments transfer to the server row and the optimistic row is
 *      dropped, otherwise it is preserved until the server echoes it back.
 *   2. Non-optimistic local rows whose id isn't on the server yet (brief
 *      replication lag or pagination) — preserved as-is.
 */
function preserveUnreflectedLocalRows(
  reconciled: DisplayMessage[],
  local: DisplayMessage[],
  serverIds: Set<string>,
): void {
  for (const m of local) {
    if (!m.isOptimistic && hasServerIdentity(serverIds, m)) {
      continue;
    }

    if (m.isOptimistic && m.role === "user") {
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
}

import { messagesEqual } from "@/domains/chat/utils/message-merge";
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
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";
import type { DisplayMessage } from "@/domains/chat/types/types";

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
 *   - `S` = the server seq (`server-seq.ts`, recorded from the
 *     top-level `seq` on `/messages`).
 *   - `L` = the local seq the live stream has carried this conversation
 *     to (`local-seq.ts`, advanced by the SSE consumer).
 *
 * When `L > S` the snapshot is stale: every row it carries reflects state at
 * or below `S`, so applying it would regress rows the stream advanced past
 * `S`. We keep the live local rows. When `S >= L` (or either is unknown) the
 * snapshot has seen everything the stream applied, so it is authoritative and
 * we take the server rows wholesale.
 *
 * Idempotent stream apply (events with `seq <= L` are no-ops) is enforced
 * upstream in the SSE consumer, so this merge never has to dedupe replays.
 *
 * Both sides are already-projected `DisplayMessage[]`: callers project the
 * wire `ConversationMessage[]` snapshot to display rows at the reconcile
 * boundary (`reconcile-snapshot.ts`), and the initial-load path already holds
 * display rows. Keeping the merge display-on-display makes it the single
 * authoritative reconcile for every snapshot-apply site.
 */
export interface ReconcileWithSeqOptions {
  /** Server seq `S` — how far `/messages` had persisted. */
  serverSeq: number | null;
  /** Local seq `L` — how far the stream has carried this conversation. */
  localSeq: number | null;
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
  server: DisplayMessage[],
  options: ReconcileWithSeqOptions,
): DisplayMessage[] {
  if (server.length === 0) {
    return local;
  }

  const streamAhead =
    options.serverSeq != null &&
    options.localSeq != null &&
    options.serverSeq < options.localSeq;

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

  const reconciled: DisplayMessage[] = server.flatMap((m) => {
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
    return [preserveClientAttachments(m, localMsg)];
  });

  preserveUnreflectedLocalRows(reconciled, local, serverIds);

  sortByTimestamp(reconciled);

  // Stability mirrors the merge's own branch decision above. A stale snapshot
  // (`streamAhead`, `S < L`) kept the live local rows and adopted only their
  // server identity, so the merge cannot have changed any row's content — the
  // only differences are structural (rows added, dropped, folded, or
  // re-identified), which the row-id sequence captures with an O(n) walk
  // instead of a deep content compare. This is the streaming hot path, where
  // debounced snapshots routinely lag the stream.
  if (streamAhead) {
    return sameIdentitySequence(local, reconciled) ? local : reconciled;
  }

  // Authoritative snapshot (`S >= L`) or a daemon predating seq reporting: the
  // merge took the server rows wholesale, so their content can differ from the
  // local rows even when the row ids line up (e.g. a server-normalized row
  // re-persisted at the same watermark). Compare content so an authoritative
  // correction is never dropped and the poll loop still settles when nothing
  // changed.
  return messagesEqual(local, reconciled) ? local : reconciled;
}

/**
 * Whether two transcripts carry the same rows in the same order, compared by
 * the server-assigned row id. The seq-path structural-stability signal: on a
 * stale snapshot (`S < L`) the merge keeps local content, so an identical id
 * sequence means the merge was a no-op and the original reference can be
 * returned for caller-side reference-equality stability.
 */
function sameIdentitySequence(
  a: DisplayMessage[],
  b: DisplayMessage[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((row, i) => row.id === b[i]?.id);
}

/**
 * Keep a live local row but stamp the server-assigned identity onto it: adopt
 * the server `id`, fold the previous local id into `mergedMessageIds`, and
 * only borrow the server timestamp when the row has none yet.
 */
function adoptServerIdentity(
  localMsg: DisplayMessage,
  server: DisplayMessage,
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
 *   1. Optimistic rows (client UUID, never in `serverIds`) — correlated by
 *      `clientMessageId` to a reconciled server row (see `findOptimisticEcho`);
 *      on a hit the client timestamp and blob attachments transfer to the
 *      server row and the optimistic row is dropped, otherwise it is preserved
 *      until the server echoes it back.
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

    if (m.isOptimistic) {
      const match = findOptimisticEcho(reconciled, m);
      if (match) {
        // Stamp the optimistic row's nonce onto the server row it folded into
        // when the daemon echoed none. This records the correlation on the
        // row's own identity, so a second nonce-less optimistic row can't also
        // fold onto it through the recency fallback (which only considers rows
        // that still carry no nonce) and drop a message from the transcript.
        if (
          m.role === "user" &&
          m.clientMessageId !== undefined &&
          match.clientMessageId === undefined
        ) {
          match.clientMessageId = m.clientMessageId;
        }
        if (!match.timestamp && m.timestamp) {
          match.timestamp = m.timestamp;
        }
        if (m.attachments && m.attachments.length > 0) {
          match.attachments = m.attachments;
        }
        continue;
      }
    }

    reconciled.push(m);
  }
}

/**
 * Resolve an optimistic local row to the reconciled server row it echoes:
 *   - user rows correlate on the client-generated `clientMessageId` nonce the
 *     daemon echoes back on the persisted row; absent the nonce (a daemon that
 *     predates the idempotency contract) they fall back to the most recent
 *     server user row that still carries no nonce. The nonce is unique per
 *     send, so the primary match is naturally one-to-one; the caller stamps
 *     the nonce onto a row folded through the fallback so a later nonce-less
 *     row can't resolve to it again. Identity-first correlation is robust to
 *     duplicate or normalized text and to two sends fired in quick succession;
 *   - assistant rows match when the streamed local text is a non-empty prefix
 *     of the server row's content — the live tail rendered before the daemon
 *     assigned the row an id (only against pre-anchor-protocol daemons that
 *     stream deltas without a `messageId`).
 */
function findOptimisticEcho(
  reconciled: DisplayMessage[],
  optimistic: DisplayMessage,
): DisplayMessage | undefined {
  if (optimistic.role === "user") {
    if (optimistic.clientMessageId !== undefined) {
      const byNonce = reconciled.find(
        (r) =>
          r.role === "user" && r.clientMessageId === optimistic.clientMessageId,
      );
      if (byNonce) {
        return byNonce;
      }
    }
    return reconciled.findLast(
      (r) => r.role === "user" && r.clientMessageId === undefined,
    );
  }

  if (optimistic.role === "assistant") {
    const optimisticText = messagePlainText(optimistic).trim();
    if (!optimisticText) {
      return undefined;
    }
    return reconciled.find(
      (r) =>
        r.role === "assistant" &&
        messagePlainText(r).trim().startsWith(optimisticText),
    );
  }

  return undefined;
}

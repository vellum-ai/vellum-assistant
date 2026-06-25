/**
 * Pure decision logic for the silent-stall watchdog.
 *
 * Both inputs are already-projected `DisplayMessage[]` — the local view (cached
 * history ⊕ live turn) and the freshly fetched server snapshot, mapped once by
 * the caller. Keeping the wire→display projection out of here makes these
 * functions pure and directly testable.
 *
 * The rescue gate is the AND of both: `serverSnapshotHasNewContent` (there is
 * anything new at all) and `serverHasAssistantProgress` (the new content is
 * assistant output). The structural half keeps a normal mid-stream poll — where
 * the live streaming row already matches a server row — from looking like a
 * missed terminal event.
 */

import {
  messageIdentityKeys,
  messageMatchKeys,
} from "@/domains/chat/utils/message-identity";
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";
import { liveAssistantRowId } from "@/domains/chat/utils/stream-updaters/shared";
import type { DisplayMessage } from "@/domains/chat/types/types";

/**
 * Whether the server snapshot carries content the local view does not yet have
 * — a row absent locally, or a matched row whose text has grown.
 */
export function serverSnapshotHasNewContent(
  serverMessages: DisplayMessage[],
  localView: DisplayMessage[],
): boolean {
  const localByKey = new Map<string, DisplayMessage>();
  for (const m of localView) {
    for (const key of messageIdentityKeys(m)) {
      if (!localByKey.has(key)) localByKey.set(key, m);
    }
  }
  for (const sm of serverMessages) {
    const match = sm.id ? localByKey.get(sm.id) : undefined;
    if (!match) return true;
    if (messagePlainText(match) !== messagePlainText(sm)) return true;
  }
  return false;
}

/**
 * Whether the server's view of the current turn shows assistant output beyond
 * what the local view has — genuine progress a silent stall caused us to miss,
 * not just bookkeeping diffs.
 */
export function serverHasAssistantProgress(
  localMessages: DisplayMessage[],
  serverMessages: DisplayMessage[],
  isProcessing: boolean,
): boolean {
  const liveRowId = liveAssistantRowId(localMessages, isProcessing);
  const lastLocalUserIndex = localMessages.findLastIndex(
    (message) => message.role === "user",
  );
  const currentTurnLocalMessages =
    lastLocalUserIndex >= 0
      ? localMessages.slice(lastLocalUserIndex + 1)
      : localMessages;
  const localAssistants = currentTurnLocalMessages.filter(
    (message) => message.role === "assistant",
  );
  const localAssistantById = new Map<string, DisplayMessage>();
  const claimedLocal = new Set<DisplayMessage>();

  for (const message of localAssistants) {
    if (message.id) {
      localAssistantById.set(message.id, message);
    }
  }

  let serverSearchStartIndex = 0;
  if (lastLocalUserIndex >= 0) {
    const lastLocalUser = localMessages[lastLocalUserIndex]!;
    const lastLocalUserText = messagePlainText(lastLocalUser);
    const serverUserIndex = serverMessages.findLastIndex((message) => {
      if (message.role !== "user") return false;
      if (lastLocalUser.id && message.id === lastLocalUser.id) return true;
      return messagePlainText(message) === lastLocalUserText;
    });
    if (serverUserIndex === -1) return false;
    serverSearchStartIndex = serverUserIndex + 1;
  }

  for (const serverMessage of serverMessages.slice(serverSearchStartIndex)) {
    if (serverMessage.role !== "assistant") continue;

    const serverMessageText = messagePlainText(serverMessage);
    const localById = serverMessage.id
      ? localAssistantById.get(serverMessage.id)
      : undefined;
    if (localById) {
      claimedLocal.add(localById);
      if (localById.id === liveRowId) return true;
      if (messagePlainText(localById) !== serverMessageText) return true;
      continue;
    }

    const localByContent = localAssistants.find(
      (message) =>
        !claimedLocal.has(message) &&
        messagePlainText(message) === serverMessageText,
    );
    if (localByContent) {
      claimedLocal.add(localByContent);
      if (localByContent.id === liveRowId) return true;
      continue;
    }

    return true;
  }

  return false;
}

/**
 * Live-turn rows the authoritative server snapshot has already superseded.
 *
 * The live-turn→history handoff (`use-conversation-history`) drops graduated
 * rows on the single sending→idle edge. If that edge is missed or races the
 * server persisting the turn — the failure mode behind "I said yo and it
 * didn't respond": the stream is aborted mid-turn by a visibility change, and
 * the replayed terminal events land on an already-idle turn, so the handoff
 * never re-runs — the graduated row is orphaned in the live turn. There it
 * shadows the complete server copy forever, because `selectTranscriptMessages`
 * lets the live copy win on content: the user keeps seeing a truncated
 * thinking-only bubble while the server holds the finished reply.
 *
 * Reconcile is the recurring authoritative refresh, so it re-runs the same
 * prune the handoff does: once the turn is terminal, any live row the server
 * snapshot already carries is stale and must be dropped so the server copy
 * renders. Returns the live rows to drop; the caller filters them out.
 *
 * Gated on `terminal`: while the turn is still streaming the live copy is
 * legitimately ahead of the server, and dropping it would flash the partial
 * server copy backward. The text-length guard is the matching safety net for a
 * terminal turn whose server persistence briefly lags the live row — only drop
 * when the server copy is no shorter than what we'd be removing.
 */
export function liveRowsSupersededByServer(
  live: DisplayMessage[],
  serverMessages: DisplayMessage[],
  terminal: boolean,
): DisplayMessage[] {
  if (!terminal || live.length === 0) return [];

  const serverByKey = new Map<string, DisplayMessage>();
  for (const sm of serverMessages) {
    for (const key of messageMatchKeys(sm)) {
      if (!serverByKey.has(key)) serverByKey.set(key, sm);
    }
  }

  const superseded: DisplayMessage[] = [];
  for (const row of live) {
    let serverTwin: DisplayMessage | undefined;
    for (const key of messageMatchKeys(row)) {
      const found = serverByKey.get(key);
      if (found) {
        serverTwin = found;
        break;
      }
    }
    if (!serverTwin) continue;
    if (messagePlainText(serverTwin).length >= messagePlainText(row).length) {
      superseded.push(row);
    }
  }
  return superseded;
}

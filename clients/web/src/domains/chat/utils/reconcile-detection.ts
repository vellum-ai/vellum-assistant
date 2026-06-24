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

import { messageIdentityKeys } from "@/domains/chat/utils/message-identity";
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

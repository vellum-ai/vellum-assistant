import type { DisplayMessage } from "@/domains/chat/types/types";
import type { MessageItem } from "@/domains/chat/transcript/types";

function addMessage(
  messages: DisplayMessage[],
  seenIds: Set<string>,
  message: DisplayMessage,
): void {
  if (!seenIds.has(message.id)) {
    seenIds.add(message.id);
    messages.push(message);
  }
}

/** Canonical rows represented by one rendered transcript message item. */
export function messageItemMembers(
  item: MessageItem,
): readonly DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  const seenIds = new Set<string>();
  for (const frame of item.cameraFrames ?? []) {
    addMessage(messages, seenIds, frame);
  }
  addMessage(messages, seenIds, item.message);
  return messages;
}

function messageIdentityIds(message: DisplayMessage): readonly string[] {
  return [
    message.id,
    ...(message.clientMessageId ? [message.clientMessageId] : []),
    ...(message.mergedMessageIds ?? []).filter((id) => id.length > 0),
  ];
}

/** Canonical, optimistic, and merged ids represented by one transcript item. */
export function messageItemIdentityIds(item: MessageItem): readonly string[] {
  const ids = new Set<string>();
  for (const message of messageItemMembers(item)) {
    for (const id of messageIdentityIds(message)) {
      ids.add(id);
    }
  }
  return [...ids];
}

export function messageItemHasIdentity(
  item: MessageItem,
  messageId: string | null,
): boolean {
  return messageId !== null && messageItemIdentityIds(item).includes(messageId);
}

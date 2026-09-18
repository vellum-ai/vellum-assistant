import {
  type ContentBlock,
  type Message,
} from "@vellumai/plugin-api";

import {
  type ConversationSurfaceSnapshot,
  listConversationSurfaceSnapshots,
} from "../../../../daemon/conversation-surface-snapshots.js";
import {
  ACTIVE_TASK_PROGRESS_BLOCK,
  formatActiveTaskProgressSnapshot,
} from "./format-task-progress-context.js";

function stripTaggedBlocksFromText(text: string): string {
  return text.replace(ACTIVE_TASK_PROGRESS_BLOCK, "");
}

function stripActiveTaskProgressBlocks(messages: Message[]): Message[] {
  let changed = false;
  const next: Message[] = [];
  for (const message of messages) {
    const content: ContentBlock[] = [];
    let contentChanged = false;
    for (const block of message.content) {
      if (block.type !== "text") {
        content.push(block);
        continue;
      }
      const stripped = stripTaggedBlocksFromText(block.text);
      if (stripped === block.text) {
        content.push(block);
        continue;
      }
      contentChanged = true;
      if (stripped.trim().length === 0) {
        continue;
      }
      content.push({ ...block, text: stripped });
    }
    if (!contentChanged) {
      next.push(message);
      continue;
    }
    changed = true;
    next.push({ ...message, content });
  }
  return changed ? next : messages;
}

function attachToTrailingUserMessage(
  messages: Message[],
  snapshot: string,
): Message[] {
  let userIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      userIndex = i;
      break;
    }
  }
  if (userIndex === -1) {
    return messages;
  }
  const user = messages[userIndex]!;
  return [
    ...messages.slice(0, userIndex),
    {
      ...user,
      content: [...user.content, { type: "text" as const, text: snapshot }],
    },
    ...messages.slice(userIndex + 1),
  ];
}

/**
 * Replace any prior tagged snapshot on the working history with the current
 * active task-progress cards. Assigns a new message array when the history
 * changes so the snapshot is not written back as ordinary transcript.
 */
export function applyTaskProgressContext(
  conversationId: string,
  messages: Message[],
): Message[] {
  const snapshots: ConversationSurfaceSnapshot[] =
    listConversationSurfaceSnapshots(conversationId);
  const snapshotText = formatActiveTaskProgressSnapshot(snapshots);
  const stripped = stripActiveTaskProgressBlocks(messages);
  if (snapshotText.length === 0) {
    return stripped;
  }
  return attachToTrailingUserMessage(stripped, snapshotText);
}

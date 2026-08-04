import type { Message } from "../providers/types.js";
import {
  attachmentsToContentBlocks,
  type MessageAttachmentInput,
} from "./attachments.js";

export async function createUserMessage(
  text: string,
  attachments: MessageAttachmentInput[] = [],
): Promise<Message> {
  const content = [] as Message["content"];
  if (text.trim().length > 0) {
    content.push({ type: "text", text });
  }
  content.push(...(await attachmentsToContentBlocks(attachments)));
  return { role: "user", content };
}

export function createAssistantMessage(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

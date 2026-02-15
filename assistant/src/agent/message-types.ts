import type { Message } from '../providers/types.js';
import { attachmentsToContentBlocks, type MessageAttachmentInput } from './attachments.js';

export type { Message, ContentBlock, TextContent } from '../providers/types.js';

export function createUserMessage(text: string, attachments: MessageAttachmentInput[] = []): Message {
  const content = [] as Message["content"];
  if (text.trim().length > 0) {
    content.push({ type: 'text', text });
  }
  content.push(...attachmentsToContentBlocks(attachments));
  return { role: 'user', content };
}

export function createAssistantMessage(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

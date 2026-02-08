import type { Message, TextContent } from '../providers/types.js';

export type { Message, ContentBlock, TextContent } from '../providers/types.js';

export function createUserMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

export function createAssistantMessage(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

export function getTextContent(message: Message): string {
  return message.content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

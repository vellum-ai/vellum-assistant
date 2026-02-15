/**
 * Dynamic-profile injection and stripping helpers extracted from Session.
 *
 * These are pure functions with no state — they wrap profile text into user
 * messages at runtime and strip it back out before persistence.
 */

import type { Message } from '../providers/types.js';

export function injectDynamicProfileIntoUserMessage(message: Message, profileText: string): Message {
  const trimmedProfile = profileText.trim();
  if (trimmedProfile.length === 0) return message;
  const block = [
    '[Dynamic profile context start]',
    trimmedProfile,
    '[Dynamic profile context end]',
  ].join('\n');
  return {
    ...message,
    content: [
      ...message.content,
      { type: 'text', text: `\n\n${block}` },
    ],
  };
}

export function stripDynamicProfileMessages(messages: Message[], profileText: string): Message[] {
  const trimmedProfile = profileText.trim();
  if (trimmedProfile.length === 0) return messages;
  const injectedBlock = `\n\n[Dynamic profile context start]\n${trimmedProfile}\n[Dynamic profile context end]`;
  return messages.map((message) => {
    if (message.role !== 'user') return message;
    let changed = false;
    const nextContent = message.content.map((block) => {
      if (block.type !== 'text') return block;
      const nextText = block.text.split(injectedBlock).join('');
      if (nextText === block.text) return block;
      changed = true;
      return {
        ...block,
        text: nextText.replace(/\n{3,}/g, '\n\n').trimEnd(),
      };
    });
    return changed ? { ...message, content: nextContent } : message;
  });
}

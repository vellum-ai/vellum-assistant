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
  // Find the last user message that actually contains the injected profile block.
  // We can't just target the last user message by role — tool_result messages also
  // have role 'user', so after tool use the last user message won't be the one
  // we injected the profile into.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].content.some(
      (b) => b.type === 'text' && b.text.includes(injectedBlock),
    )) { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return messages;
  const message = messages[lastUserIdx];
  let changed = false;
  const nextContent = message.content.map((block) => {
    if (block.type !== 'text') return block;
    const nextText = block.text.split(injectedBlock).join('');
    if (nextText === block.text) return block;
    changed = true;
    const stripped = nextText.replace(/\n{3,}/g, '\n\n').trimEnd();
    return stripped.length > 0 ? { ...block, text: stripped } : null;
  }).filter((block): block is NonNullable<typeof block> => block !== null);
  if (!changed) return messages;
  return [
    ...messages.slice(0, lastUserIdx),
    { ...message, content: nextContent },
    ...messages.slice(lastUserIdx + 1),
  ];
}

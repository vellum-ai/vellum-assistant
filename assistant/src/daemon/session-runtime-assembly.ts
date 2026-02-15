/**
 * Runtime message-injection helpers extracted from Session.
 *
 * These functions modify the user-message tail of the conversation
 * before it is sent to the provider.  They are pure (no side effects).
 */

import type { Message } from '../providers/types.js';

/**
 * Append a memory-conflict clarification instruction to the last user message.
 */
export function injectClarificationRequestIntoUserMessage(message: Message, question: string): Message {
  const instruction = [
    '[Memory clarification request]',
    `Ask this once in your response: ${question}`,
    'After asking, continue helping with the current request.',
  ].join('\n');
  return {
    ...message,
    content: [
      ...message.content,
      { type: 'text', text: `\n\n${instruction}` },
    ],
  };
}

/**
 * Prepend the current dynamic-page HTML so the model can refine UI surfaces.
 */
export function injectActiveSurfaceContext(message: Message, surfaceId: string, html: string): Message {
  const MAX_HTML_LENGTH = 100_000;
  const truncatedHtml = html.length > MAX_HTML_LENGTH
    ? html.slice(0, MAX_HTML_LENGTH) + `\n<!-- truncated: original is ${html.length} characters -->`
    : html;
  const block = [
    '<active_dynamic_page>',
    `The user is viewing a dynamic page (surface_id: "${surfaceId}") in workspace mode.`,
    `To modify this page, call ui_update with surface_id "${surfaceId}" and provide the complete updated HTML in data.html.`,
    'Preserve all existing content, design tokens, and styling unless the user explicitly asks to change them.',
    '',
    'Current HTML:',
    truncatedHtml,
    '</active_dynamic_page>',
  ].join('\n');
  return {
    ...message,
    content: [
      { type: 'text', text: block },
      ...message.content,
    ],
  };
}

/**
 * Strip `<active_dynamic_page>` blocks that were injected by
 * `injectActiveSurfaceContext`.  Called after the agent run to prevent
 * the (potentially 100 KB) surface HTML from persisting in session history.
 */
export function stripActiveSurfaceContext(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'user') return message;
    const nextContent = message.content.filter((block) => {
      if (block.type !== 'text') return true;
      return !block.text.startsWith('<active_dynamic_page>');
    });
    if (nextContent.length === message.content.length) return message;
    return { ...message, content: nextContent };
  });
}

/**
 * Apply a chain of user-message injections to `runMessages`.
 *
 * Each injection is optional — pass `null`/`undefined` to skip it.
 * Returns the final message array ready for the provider.
 */
export function applyRuntimeInjections(
  runMessages: Message[],
  options: {
    softConflictInstruction?: string | null;
    activeSurface?: { surfaceId: string; html: string } | null;
  },
): Message[] {
  let result = runMessages;

  if (options.softConflictInstruction) {
    const userTail = result[result.length - 1];
    if (userTail && userTail.role === 'user') {
      result = [
        ...result.slice(0, -1),
        injectClarificationRequestIntoUserMessage(userTail, options.softConflictInstruction),
      ];
    }
  }

  if (options.activeSurface) {
    const userTail = result[result.length - 1];
    if (userTail && userTail.role === 'user') {
      result = [
        ...result.slice(0, -1),
        injectActiveSurfaceContext(userTail, options.activeSurface.surfaceId, options.activeSurface.html),
      ];
    }
  }

  return result;
}

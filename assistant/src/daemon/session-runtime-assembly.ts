/**
 * Runtime message-injection helpers extracted from Session.
 *
 * These functions modify the user-message tail of the conversation
 * before it is sent to the provider.  They are pure (no side effects).
 */

import type { Message } from '../providers/types.js';

/** Context about the active workspace surface, passed to applyRuntimeInjections. */
export interface ActiveSurfaceContext {
  surfaceId: string;
  html: string;
  /** When set, the surface is backed by a persisted app. */
  appId?: string;
  appName?: string;
  appSchemaJson?: string;
  /** Additional pages keyed by filename (e.g. "settings.html" → HTML content). */
  appPages?: Record<string, string>;
}

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

const MAX_CONTEXT_LENGTH = 100_000;

function truncateHtml(html: string, budget: number): string {
  if (html.length <= budget) return html;
  return html.slice(0, budget) + `\n<!-- truncated: original is ${html.length} characters -->`;
}

/**
 * Prepend workspace context so the model can refine UI surfaces.
 * Adapts the injected rules based on whether the surface is app-backed.
 */
export function injectActiveSurfaceContext(message: Message, ctx: ActiveSurfaceContext): Message {
  const lines: string[] = ['<active_workspace>'];

  if (ctx.appId) {
    // ── App-backed surface ──
    lines.push(
      `The user is viewing app "${ctx.appName ?? 'Untitled'}" (app_id: "${ctx.appId}") in workspace mode.`,
      '',
      'RULES FOR WORKSPACE MODIFICATION:',
      `1. Call \`app_update\` with app_id "${ctx.appId}" and the updated \`html\` to apply changes.`,
      '   The surface refreshes automatically — do NOT call ui_show or ui_update.',
      '2. You MAY call other tools first to gather data (get_weather, web_search, etc.)',
      '   before calling app_update.',
      '3. Make ONLY the changes the user requested. Preserve all existing content,',
      '   styling, and functionality unless explicitly asked to change them.',
      '4. When adding new content, match the existing visual style.',
      '5. Keep your text response to 1 brief sentence confirming what you changed.',
    );

    // App structure metadata
    lines.push('', 'App structure:');
    const pageNames = ctx.appPages ? Object.keys(ctx.appPages) : [];
    lines.push(`- Main page (index.html): shown below`);
    if (pageNames.length > 0) {
      lines.push(`- Additional pages: ${pageNames.join(', ')}`);
      lines.push('  To modify additional pages, include the `pages` parameter in `app_update`.');
      lines.push('  To add a new page, include it in `pages` with its HTML content.');
    } else {
      lines.push('- Additional pages: none');
    }
    const schema = ctx.appSchemaJson;
    if (schema && schema !== '"{}"' && schema !== '{}') {
      lines.push(`- Data schema: ${schema}`);
    } else {
      lines.push('- Data schema: none (display-only)');
    }

    // Main page HTML — reserve budget for additional pages
    let mainBudget = MAX_CONTEXT_LENGTH;
    const additionalPageBlocks: string[] = [];

    if (ctx.appPages && pageNames.length > 0) {
      // Try to include additional page content if total fits
      let additionalSize = 0;
      for (const [filename, content] of Object.entries(ctx.appPages)) {
        additionalSize += filename.length + content.length + 30; // overhead for delimiters
        additionalPageBlocks.push(`--- ${filename} ---`, content);
      }
      if (additionalSize + ctx.html.length > MAX_CONTEXT_LENGTH) {
        // Too large — omit page content, just list names (already done above)
        additionalPageBlocks.length = 0;
      } else {
        mainBudget = MAX_CONTEXT_LENGTH - additionalSize;
      }
    }

    lines.push('', 'Current HTML (index.html):', truncateHtml(ctx.html, mainBudget));

    if (additionalPageBlocks.length > 0) {
      lines.push('', 'Additional page content:', ...additionalPageBlocks);
    }
  } else {
    // ── Ephemeral surface (created via ui_show, no persisted app) ──
    lines.push(
      `The user is viewing a dynamic page (surface_id: "${ctx.surfaceId}") in workspace mode.`,
      '',
      'RULES FOR WORKSPACE MODIFICATION:',
      `1. Call \`ui_update\` with surface_id "${ctx.surfaceId}" and data.html containing`,
      '   the complete updated HTML.',
      '2. You MAY call other tools first to gather data before calling ui_update.',
      '3. Do NOT call ui_show — modify the existing page.',
      '4. Make ONLY the changes the user requested. Preserve all existing content,',
      '   styling, and functionality unless explicitly asked to change them.',
      '5. Keep your text response to 1 brief sentence confirming what you changed.',
      '',
      'Current HTML:',
      truncateHtml(ctx.html, MAX_CONTEXT_LENGTH),
    );
  }

  lines.push('</active_workspace>');

  const block = lines.join('\n');
  return {
    ...message,
    content: [
      { type: 'text', text: block },
      ...message.content,
    ],
  };
}

/**
 * Strip `<active_workspace>` (and legacy `<active_dynamic_page>`) blocks
 * injected by `injectActiveSurfaceContext`.  Called after the agent run to
 * prevent the (potentially 100 KB) surface HTML from persisting in session
 * history.
 */
export function stripActiveSurfaceContext(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'user') return message;
    const nextContent = message.content.filter((block) => {
      if (block.type !== 'text') return true;
      return !block.text.startsWith('<active_workspace>') && !block.text.startsWith('<active_dynamic_page>');
    });
    if (nextContent.length === message.content.length) return message;
    if (nextContent.length === 0) return null;
    return { ...message, content: nextContent };
  }).filter((message): message is NonNullable<typeof message> => message !== null);
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
    activeSurface?: ActiveSurfaceContext | null;
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
        injectActiveSurfaceContext(userTail, options.activeSurface),
      ];
    }
  }

  return result;
}
